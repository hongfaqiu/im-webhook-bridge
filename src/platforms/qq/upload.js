// QQ 富媒体上传：小文件 base64 / ≥5MB 分片 / URL 直传，上传缓存（md5|scope|target|type → file_info）
// 协议参考 @tencent-connect/openclaw-qqbot 2.0.4（media.js / media-chunked.js）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { readJSON, writeJSON, sleep } from '../../util.js';
import { downloadToFile, fmtSize, MB } from '../../core/media.js';

export const FILE_TYPE = { image: 1, video: 2, voice: 3, file: 4 };
export const TYPE_LIMIT = { image: 30 * MB, video: 100 * MB, voice: 20 * MB, file: 100 * MB };
export const HARD_MAX = Number(process.env.IMWB_QQ_SEND_MAX || 100 * MB);
const SIMPLE_MAX = 20 * MB;
const CHUNK_THRESHOLD = Number(process.env.IMWB_QQ_CHUNK_THRESHOLD || 5 * MB);
const UPLOAD_TIMEOUT = 120000;
const PART_TIMEOUT = 300000;
const PART_FINISH_RETRY_CODE = 40093001;
const DAILY_LIMIT_CODE = 40093002;
const VOICE_DIRECT = ['.wav', '.mp3', '.silk', '.slk'];

function fileHashes(p, size) {
  return new Promise((res, rej) => {
    const md5 = crypto.createHash('md5'), sha1 = crypto.createHash('sha1'), m10 = crypto.createHash('md5');
    const LIM = 10002432; let used = 0;
    fs.createReadStream(p).on('data', b => { md5.update(b); sha1.update(b); if (size > LIM && used < LIM) m10.update(b.subarray(0, LIM - used)); used += b.length; })
      .on('end', () => { const m = md5.digest('hex'); res({ md5: m, sha1: sha1.digest('hex'), md5_10m: size > LIM ? m10.digest('hex') : m }); })
      .on('error', rej);
  });
}
const uploadPath = (scope, target, kind) => `/v2/${scope === 'group' ? 'groups' : 'users'}/${target}/${kind}`;

async function putPart(url, buf) {
  let last;
  for (let i = 0; i <= 2; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), PART_TIMEOUT);
    try {
      const r = await fetch(url, { method: 'PUT', body: buf, headers: { 'Content-Length': String(buf.length) }, signal: ctl.signal });
      if (r.status >= 200 && r.status < 300) return;
      last = new Error(`COS PUT ${r.status}`);
    } catch (e) { last = e.name === 'AbortError' ? new Error('分片上传超时') : e; }
    finally { clearTimeout(t); }
    if (i < 2) await sleep(1000 * 2 ** i);
  }
  throw last;
}

async function uploadChunked(api, scope, target, spec, log) {
  const h = await fileHashes(spec.path, spec.size);
  let prep;
  try {
    prep = await api('POST', uploadPath(scope, target, 'upload_prepare'), { file_type: FILE_TYPE[spec.type], file_name: spec.name, file_size: spec.size, md5: h.md5, sha1: h.sha1, md5_10m: h.md5_10m }, { timeoutMs: UPLOAD_TIMEOUT });
  } catch (e) { if (e.code === DAILY_LIMIT_CODE) e.dailyLimit = true; throw e; }
  const { upload_id, parts, block_size } = prep;
  if (!upload_id || !Array.isArray(parts)) throw new Error('upload_prepare 返回缺少 upload_id/parts');
  const retryMs = prep.retry_timeout ? Math.min(prep.retry_timeout * 1000, 600000) : 120000;
  log(`分片上传 ${spec.name} ${fmtSize(spec.size)} parts=${parts.length}`);
  const fd = await fs.promises.open(spec.path, 'r');
  try {
    for (const part of parts) {
      const off = (part.index - 1) * block_size; const len = Math.min(block_size, spec.size - off);
      const buf = Buffer.alloc(len); const { bytesRead } = await fd.read(buf, 0, len, off);
      const data = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
      const md5 = crypto.createHash('md5').update(data).digest('hex');
      await putPart(part.presigned_url, data);
      const deadline = Date.now() + retryMs; let n = 0;
      for (;;) {
        try { await api('POST', uploadPath(scope, target, 'upload_part_finish'), { upload_id, part_index: part.index, block_size: data.length, md5 }, { timeoutMs: UPLOAD_TIMEOUT }); break; }
        catch (e) {
          if (e.code === PART_FINISH_RETRY_CODE && Date.now() < deadline) { await sleep(1000); continue; }
          if (e.code !== PART_FINISH_RETRY_CODE && n < 2) { n++; await sleep(1000 * 2 ** n); continue; }
          throw e;
        }
      }
    }
  } finally { await fd.close(); }
  let last;
  for (let i = 0; i <= 2; i++) {
    try { return await api('POST', uploadPath(scope, target, 'files'), { upload_id }, { timeoutMs: UPLOAD_TIMEOUT }); }
    catch (e) { last = e; if (i < 2) await sleep(2000 * 2 ** i); }
  }
  throw last;
}

async function uploadSimple(api, scope, target, spec, body) {
  const b = { file_type: FILE_TYPE[spec.type], srv_send_msg: false, ...body };
  if (spec.type === 'file') b.file_name = spec.name;
  let last;
  for (let i = 0; i <= 1; i++) {
    try { return await api('POST', uploadPath(scope, target, 'files'), b, { timeoutMs: UPLOAD_TIMEOUT }); }
    catch (e) { last = e; if (e.status && e.status < 500) break; if (/超时|timeout/i.test(e.message)) break; if (i < 1) await sleep(1000); }
  }
  throw last;
}

// 语音：wav/mp3/silk 直传，其他格式用 ffmpeg 转 mp3；没 ffmpeg 或失败 → null（调用方改按文件发）
function transcodeVoice(src, tmp) {
  return new Promise(res => {
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const out = path.join(tmp, `voice_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.mp3`);
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '24000', '-b:a', '64k', out], { timeout: 120000 }, err => res(err ? null : out));
  });
}

// 每个账号一个上传器（缓存、临时目录都在账号目录里）
export function createUploader(dir, api, log = () => {}) {
  const TMP = path.join(dir, 'tmp');
  const CACHE_F = path.join(dir, 'upload-cache.json');
  const cacheGet = key => { const c = readJSON(CACHE_F, {}); const e = c[key]; return e && e.exp > Date.now() ? e : null; };
  function cacheSet(key, file_info, ttl) {
    if (!file_info || !(ttl > 0)) return;
    const c = readJSON(CACHE_F, {}); const now = Date.now();
    for (const k of Object.keys(c)) if (c[k].exp <= now) delete c[k];
    c[key] = { file_info, exp: now + Math.max(0, ttl - 120) * 1000 };
    writeJSON(CACHE_F, c, 0o600);
  }
  // → {file_info, ttl, via}
  return async function uploadMedia(scope, target, spec, opts = {}) {
    let cleanup = null;
    try {
      let s = { ...spec };
      if (s.source === 'url') {
        try {
          const r = await uploadSimple(api, scope, target, s, { url: s.url });
          if (r.file_info) return { ...r, via: 'url' };
          throw new Error('URL 上传没返回 file_info');
        } catch (e) {
          if (e.status === 401) throw e;
          log('URL 直传失败，改为下载后上传', s.name, e.message);
          const tmp = path.join(TMP, `dl_${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${s.name}`);
          const d = await downloadToFile(s.url, tmp, HARD_MAX, 300000);
          cleanup = tmp; s = { ...s, source: 'path', path: tmp, size: d.size };
          if (d.size > TYPE_LIMIT[s.type]) s.type = 'file';
        }
      }
      if (!fs.existsSync(s.path)) throw new Error(`文件不存在：${s.path}`);
      if (s.type === 'voice' && !VOICE_DIRECT.includes(path.extname(s.path).toLowerCase())) {
        const out = await transcodeVoice(s.path, TMP);
        if (!out) { const e = new Error('语音格式需转码但 ffmpeg 转码失败'); e.voiceFallback = true; throw e; }
        if (cleanup) try { fs.unlinkSync(cleanup); } catch {}
        cleanup = out; s = { ...s, path: out, size: fs.statSync(out).size };
      }
      const h = await fileHashes(s.path, s.size);
      const key = `${h.md5}|${scope}|${target}|${s.type}`;
      const hit = cacheGet(key);
      if (hit && !opts.noCache) return { file_info: hit.file_info, ttl: 0, via: 'cache' };
      let r;
      if (s.size >= CHUNK_THRESHOLD || opts.forceChunked) {
        try { r = await uploadChunked(api, scope, target, s, log); r.via = 'chunked'; }
        catch (e) { if (e.dailyLimit && s.size <= SIMPLE_MAX) log('分片上传达每日上限，改用整包上传'); else throw e; }
      }
      if (!r) {
        if (s.size > SIMPLE_MAX) throw new Error(`文件 ${fmtSize(s.size)} 超过整包上传上限 ${fmtSize(SIMPLE_MAX)}`);
        const data = (await fs.promises.readFile(s.path)).toString('base64');
        r = await uploadSimple(api, scope, target, s, { file_data: data }); r.via = 'base64';
      }
      if (!r.file_info) throw new Error('上传没返回 file_info');
      cacheSet(key, r.file_info, r.ttl);
      return r;
    } finally { if (cleanup) try { fs.unlinkSync(cleanup); } catch {} }
  };
}
