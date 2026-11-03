// 媒体公共层：类型推断、文件名清理、SSRF 防护、限额下载（可串解密流）、/reply 的 files 校验
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MB = 1024 * 1024;
export const GB = 1024 * MB;
export const FILE_TYPES = ['image', 'video', 'voice', 'file'];

const EXT = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'],
  video: ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.flv'],
  voice: ['.silk', '.slk', '.amr', '.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac', '.opus'],
};

export function inferType(name, mime) {
  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/') || mime === 'voice') return 'voice';
  }
  const ext = path.extname(name || '').toLowerCase();
  for (const k of Object.keys(EXT)) if (EXT[k].includes(ext)) return k;
  return 'file';
}

export function sanitizeFileName(name) {
  const c = String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return c || 'file';
}

export function fmtSize(n) { return n == null ? '?' : n < MB ? (n / 1024).toFixed(1) + 'KB' : (n / MB).toFixed(1) + 'MB'; }

export function normalizeLocal(p) {
  let r = String(p);
  if (r.startsWith('file://')) { r = r.slice(7); try { r = decodeURIComponent(r); } catch {} }
  if (r === '~' || r.startsWith('~/')) r = r.replace(/^~/, os.homedir());
  return path.resolve(r);
}

// SSRF：只允许 http(s)，且不指向内网 / 本机
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && isPrivateIp(l.slice(7)));
}

export async function assertPublicUrl(u) {
  let url; try { url = new URL(u); } catch { throw new Error('URL 无效'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 http/https URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('URL 指向内网/本机地址，已拦截');
  return url;
}

// 下载到文件（流式、限额、超时、600 权限）；opts.transform 可插入解密流（微信 CDN 用）
export async function downloadToFile(url, dest, maxBytes, timeoutMs, opts = {}) {
  if (!opts.allowPrivate) await assertPublicUrl(url);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: opts.headers });
    if (!r.ok) throw new Error(`下载 HTTP ${r.status}`);
    const cl = Number(r.headers.get('content-length'));
    if (cl > maxBytes) throw new Error(`文件 ${fmtSize(cl)} 超过上限 ${fmtSize(maxBytes)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    let n = 0;
    const counted = async function* (src) {
      for await (const chunk of src) { n += chunk.length; if (n > maxBytes) throw new Error(`文件超过上限 ${fmtSize(maxBytes)}`); yield chunk; }
    };
    const stages = [Readable.fromWeb(r.body), counted];
    if (opts.transform) stages.push(opts.transform());
    try { await pipeline(...stages, fs.createWriteStream(dest, { mode: 0o600 })); }
    catch (e) { try { fs.unlinkSync(dest); } catch {} throw e; }
    fs.chmodSync(dest, 0o600);
    return { size: fs.statSync(dest).size, content_type: (r.headers.get('content-type') || '').split(';')[0] || null };
  } catch (e) {
    if (e.name === 'AbortError' || ctl.signal.aborted) throw new Error(`下载超时（${Math.round(timeoutMs / 1000)}s）`);
    throw e;
  } finally { clearTimeout(t); }
}

// 不允许把桥接自己的 data/（凭证、会话、上下文）发出去；各账号的 inbox-files/ 除外
export function makeForbidden(dataRoots) {
  const roots = dataRoots.map(d => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } });
  return real => {
    if (/^(credentials\.json|webhook_url|webhook_key|contexts\.json|sync_buf|session\.json)$/.test(path.basename(real))) return true;
    for (const r of roots) {
      if (real === r || real.startsWith(r + path.sep)) return !real.split(path.sep).includes('inbox-files');
    }
    return false;
  };
}

// 解析 /reply 里的一个 files 项 → 规范化描述（不读内容）；出错抛中文错误
// limits: {hardMax, perType:{image,video,voice,file}}；forbidden: makeForbidden() 的返回值
export async function resolveFileSpec(spec, { limits, forbidden = () => false, fetchHead = true } = {}) {
  const HARD_MAX = limits?.hardMax ?? 100 * MB;
  const TYPE_LIMIT = limits?.perType ?? { image: 30 * MB, video: 100 * MB, voice: 20 * MB, file: 100 * MB };
  if (!spec || typeof spec !== 'object') throw new Error('files 项必须是对象 {path|url, type?, name?}');
  const hasPath = !!spec.path, hasUrl = !!spec.url;
  if (hasPath === hasUrl) throw new Error('files 项需要且只能有 path 或 url 之一');
  let type = spec.type ? String(spec.type).toLowerCase() : null;
  if (type && !FILE_TYPES.includes(type)) throw new Error(`type 只能是 image/video/voice/file，收到 ${spec.type}`);
  const notes = [];
  const caption = spec.caption ? String(spec.caption) : undefined;
  if (hasPath) {
    const abs = normalizeLocal(spec.path);
    let real; try { real = fs.realpathSync(abs); } catch { throw new Error(`文件不存在：${abs}`); }
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`不是普通文件：${real}`);
    try { fs.accessSync(real, fs.constants.R_OK); } catch { throw new Error(`文件不可读：${real}`); }
    if (forbidden(real)) throw new Error('不允许发送桥接 data/ 目录里的内部文件');
    const name = sanitizeFileName(spec.name || path.basename(real));
    if (st.size === 0) throw new Error(`文件是空的：${name}`);
    if (st.size > HARD_MAX) throw new Error(`文件「${name}」${fmtSize(st.size)}，超过 ${fmtSize(HARD_MAX)} 上限，未发送（可压缩/拆分，或发网盘链接）`);
    type = type || inferType(name);
    if (st.size > TYPE_LIMIT[type]) { notes.push(`${type} 上限 ${fmtSize(TYPE_LIMIT[type])}，改按文件发送`); type = 'file'; }
    return { source: 'path', path: real, name, size: st.size, type, notes, caption };
  }
  const url = await assertPublicUrl(spec.url);
  let size = null, mime = null;
  if (fetchHead) try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal }).finally(() => clearTimeout(t));
    if (r.ok) { const cl = Number(r.headers.get('content-length')); if (cl > 0) size = cl; mime = (r.headers.get('content-type') || '').split(';')[0] || null; }
  } catch {}
  let name = spec.name || decodeURIComponent(path.basename(url.pathname)) || 'file';
  name = sanitizeFileName(name);
  if (size != null && size > HARD_MAX) throw new Error(`URL 文件「${name}」${fmtSize(size)}，超过 ${fmtSize(HARD_MAX)} 上限，未发送`);
  type = type || inferType(name, mime);
  if (size != null && size > TYPE_LIMIT[type]) { notes.push(`${type} 上限 ${fmtSize(TYPE_LIMIT[type])}，改按文件发送`); type = 'file'; }
  return { source: 'url', url: url.toString(), name, size, type, notes, caption };
}

// 收件附件的落盘路径：<dir>/inbox-files/<北京日期>/<hhmmss>_<短 hash>_<文件名>
export function inboxFilePath(root, day, hms, short, base) {
  const dir = path.join(root, day);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); fs.chmodSync(dir, 0o700); } catch {}
  let dest = path.join(dir, `${hms}_${short}_${base}`); let n = 1;
  while (fs.existsSync(dest)) dest = path.join(dir, `${hms}_${short}_${n++}_${base}`);
  return dest;
}
