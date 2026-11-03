'use strict';
// 富媒体：类型推断、校验、上传（小文件 base64 / 大文件分片 / URL）、上传缓存
// 协议照 @tencent-connect/openclaw-qqbot 2.0.4（qqbot-nodejs media.js / media-chunked.js）
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { execFile } = require('child_process');
const { DATA, P, readJSON, writeJSON } = require('./lib');

const MB = 1024 * 1024;
const FILE_TYPE = { image: 1, video: 2, voice: 3, file: 4 };
const TYPE_LIMIT = { image: 30 * MB, video: 100 * MB, voice: 20 * MB, file: 100 * MB };
const HARD_MAX = Number(process.env.QQBOT_SEND_MAX || 100 * MB);
const SIMPLE_MAX = 20 * MB;                 // 单次 base64 上传上限
const CHUNK_THRESHOLD = Number(process.env.QQBOT_CHUNK_THRESHOLD || 5 * MB);
const UPLOAD_TIMEOUT = 120000;
const PART_TIMEOUT = 300000;
const PART_FINISH_RETRY_CODE = 40093001;
const DAILY_LIMIT_CODE = 40093002;
const TMP = path.join(DATA, 'tmp');

const EXT = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'],
  video: ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.flv'],
  voice: ['.silk', '.slk', '.amr', '.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac', '.opus'],
};
const VOICE_DIRECT = ['.wav', '.mp3', '.silk', '.slk'];

function inferType(name, mime) {
  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/') || mime === 'voice') return 'voice';
  }
  const ext = path.extname(name || '').toLowerCase();
  for (const k of Object.keys(EXT)) if (EXT[k].includes(ext)) return k;
  return 'file';
}
function sanitizeFileName(name) {
  const c = String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return c || 'file';
}
function fmtSize(n) { return n == null ? '?' : n < MB ? (n / 1024).toFixed(1) + 'KB' : (n / MB).toFixed(1) + 'MB'; }
function normalizeLocal(p) {
  let r = String(p);
  if (r.startsWith('file://')) { r = r.slice(7); try { r = decodeURIComponent(r); } catch {} }
  if (r === '~' || r.startsWith('~/')) r = r.replace(/^~/, os.homedir());
  return path.resolve(r);
}

// 不允许发桥接自己的 data/（凭证、会话等），收件附件目录除外
const DATA_REAL = (() => { try { return fs.realpathSync(DATA); } catch { return DATA; } })();
const INBOX_FILES = path.join(DATA_REAL, 'inbox-files');
function forbiddenPath(real) {
  if (path.basename(real) === 'credentials.json') return true;
  if (real === DATA_REAL || real.startsWith(DATA_REAL + path.sep)) return !real.startsWith(INBOX_FILES + path.sep);
  return false;
}

// SSRF：只允许 http(s) 且不指向内网/本机
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && isPrivateIp(l.slice(7)));
}
async function assertPublicUrl(u) {
  let url; try { url = new URL(u); } catch { throw new Error('URL 无效'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 http/https URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('URL 指向内网/本机地址，已拦截');
  return url;
}

// 解析 /reply 里的一个 files 项 → 规范化描述（不读内容）；出错抛中文错误
async function resolveFileSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('files 项必须是对象 {path|url, type?, name?}');
  const hasPath = !!spec.path, hasUrl = !!spec.url;
  if (hasPath === hasUrl) throw new Error('files 项需要且只能有 path 或 url 之一');
  let type = spec.type ? String(spec.type).toLowerCase() : null;
  if (type && !FILE_TYPE[type]) throw new Error(`type 只能是 image/video/voice/file，收到 ${spec.type}`);
  const notes = [];
  if (hasPath) {
    const abs = normalizeLocal(spec.path);
    let real; try { real = fs.realpathSync(abs); } catch { throw new Error(`文件不存在：${abs}`); }
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`不是普通文件：${real}`);
    try { fs.accessSync(real, fs.constants.R_OK); } catch { throw new Error(`文件不可读：${real}`); }
    if (forbiddenPath(real)) throw new Error('不允许发送桥接 data/ 目录里的内部文件');
    const name = sanitizeFileName(spec.name || path.basename(real));
    if (st.size === 0) throw new Error(`文件是空的：${name}`);
    if (st.size > HARD_MAX) throw new Error(`文件「${name}」${fmtSize(st.size)}，超过 ${fmtSize(HARD_MAX)} 上限，未发送（可压缩/拆分，或发网盘链接）`);
    type = type || inferType(name);
    if (st.size > TYPE_LIMIT[type]) { notes.push(`${type} 上限 ${fmtSize(TYPE_LIMIT[type])}，改按文件发送`); type = 'file'; }
    return { source: 'path', path: real, name, size: st.size, type, notes };
  }
  const url = await assertPublicUrl(spec.url);
  let size = null, mime = null;
  try { // HEAD 探测大小
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal }).finally(() => clearTimeout(t));
    if (r.ok) { const cl = Number(r.headers.get('content-length')); if (cl > 0) size = cl; mime = (r.headers.get('content-type') || '').split(';')[0] || null; }
  } catch {}
  let name = spec.name || decodeURIComponent(path.basename(url.pathname)) || 'file';
  name = sanitizeFileName(name);
  if (size != null && size > HARD_MAX) throw new Error(`URL 文件「${name}」${fmtSize(size)}，超过 ${fmtSize(HARD_MAX)} 上限，未发送`);
  type = type || inferType(name, mime);
  if (size != null && size > TYPE_LIMIT[type]) { notes.push(`${type} 上限 ${fmtSize(TYPE_LIMIT[type])}，改按文件发送`); type = 'file'; }
  return { source: 'url', url: url.toString(), name, size, type, notes };
}

// ---------- 上传缓存（md5+scope+target+type → file_info，按 ttl 过期） ----------
const CACHE_F = path.join(DATA, 'upload-cache.json');
function cacheGet(key) { const c = readJSON(CACHE_F, {}); const e = c[key]; return e && e.exp > Date.now() ? e : null; }
function cacheSet(key, file_info, ttl) {
  if (!file_info || !(ttl > 0)) return;
  const c = readJSON(CACHE_F, {}); const now = Date.now();
  for (const k of Object.keys(c)) if (c[k].exp <= now) delete c[k];
  c[key] = { file_info, exp: now + Math.max(0, ttl - 120) * 1000 };
  writeJSON(CACHE_F, c, 0o600);
}
function fileHashes(p, size) {
  return new Promise((res, rej) => {
    const md5 = crypto.createHash('md5'), sha1 = crypto.createHash('sha1'), m10 = crypto.createHash('md5');
    const LIM = 10002432; let used = 0;
    fs.createReadStream(p).on('data', b => { md5.update(b); sha1.update(b); if (size > LIM && used < LIM) m10.update(b.subarray(0, LIM - used)); used += b.length; })
      .on('end', () => { const m = md5.digest('hex'); res({ md5: m, sha1: sha1.digest('hex'), md5_10m: size > LIM ? m10.digest('hex') : m }); })
      .on('error', rej);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function uploadPath(scope, target, kind) { return `/v2/${scope === 'group' ? 'groups' : 'users'}/${target}/${kind}`; }

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
  const ftype = FILE_TYPE[spec.type];
  const h = await fileHashes(spec.path, spec.size);
  let prep;
  try {
    prep = await api('POST', uploadPath(scope, target, 'upload_prepare'), { file_type: ftype, file_name: spec.name, file_size: spec.size, md5: h.md5, sha1: h.sha1, md5_10m: h.md5_10m }, { timeoutMs: UPLOAD_TIMEOUT });
  } catch (e) { if (e.code === DAILY_LIMIT_CODE) e.dailyLimit = true; throw e; }
  const { upload_id, parts, block_size } = prep;
  if (!upload_id || !Array.isArray(parts)) throw new Error('upload_prepare 返回缺少 upload_id/parts');
  const retryMs = prep.retry_timeout ? Math.min(prep.retry_timeout * 1000, 600000) : 120000;
  log && log(`分片上传 ${spec.name} ${fmtSize(spec.size)} parts=${parts.length}`);
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

// 下载 URL 到 tmp（URL 上传失败时兜底）
async function downloadToFile(url, dest, maxBytes, timeoutMs, opts = {}) {
  if (!opts.allowPrivate) await assertPublicUrl(url);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl.signal });
    if (!r.ok) throw new Error(`下载 HTTP ${r.status}`);
    const cl = Number(r.headers.get('content-length'));
    if (cl > maxBytes) throw new Error(`文件 ${fmtSize(cl)} 超过上限 ${fmtSize(maxBytes)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const out = fs.createWriteStream(dest, { mode: 0o600 }); let n = 0;
    try {
      for await (const chunk of r.body) {
        n += chunk.length;
        if (n > maxBytes) throw new Error(`文件超过上限 ${fmtSize(maxBytes)}`);
        if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      }
    } catch (e) { out.destroy(); try { fs.unlinkSync(dest); } catch {} throw e; }
    await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
    fs.chmodSync(dest, 0o600);
    return { size: n, content_type: (r.headers.get('content-type') || '').split(';')[0] || null };
  } catch (e) { if (e.name === 'AbortError') throw new Error(`下载超时（${Math.round(timeoutMs / 1000)}s）`); throw e; }
  finally { clearTimeout(t); }
}

// 语音：wav/mp3/silk 直传，其他格式用 ffmpeg 转 mp3；没 ffmpeg 或失败 → null（调用方改按文件发）
function transcodeVoice(src) {
  return new Promise(res => {
    fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
    const out = path.join(TMP, `voice_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.mp3`);
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '24000', '-b:a', '64k', out], { timeout: 120000 }, err => res(err ? null : out));
  });
}

// 主入口：上传 → {file_info, ttl, file_uuid, via}
async function uploadMedia(api, scope, target, spec, log, opts = {}) {
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
        log && log('URL 直传失败，改为下载后上传', s.name, e.message);
        const tmp = path.join(TMP, `dl_${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${s.name}`);
        const d = await downloadToFile(s.url, tmp, HARD_MAX, 300000);
        cleanup = tmp; s = { ...s, source: 'path', path: tmp, size: d.size };
        if (d.size > TYPE_LIMIT[s.type]) s.type = 'file';
      }
    }
    if (s.type === 'voice' && !VOICE_DIRECT.includes(path.extname(s.path).toLowerCase())) {
      const out = await transcodeVoice(s.path);
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
      catch (e) {
        if (e.dailyLimit && s.size <= SIMPLE_MAX) { log && log('分片上传达每日上限，改用整包上传'); }
        else throw e;
      }
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
}

module.exports = { FILE_TYPE, TYPE_LIMIT, HARD_MAX, inferType, sanitizeFileName, fmtSize, resolveFileSpec, uploadMedia, downloadToFile, assertPublicUrl, isPrivateIp };
