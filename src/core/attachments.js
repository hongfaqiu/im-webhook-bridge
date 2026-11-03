// 收件附件自动下载（平台无关）：<account dir>/inbox-files/<北京日期>/<hhmmss>_<hash>_<原名>，文件 600、目录 700。
// 平台给出下载源 sources: [{ url, wav?, transform?, allowPrivate?, headers? }]，按顺序尝试。
import crypto from 'node:crypto';
import { bjDate } from '../util.js';
import { downloadToFile, sanitizeFileName, inboxFilePath, GB, fmtSize } from './media.js';

export const DL_MAX = Number(process.env.IMWB_DL_MAX || GB);
export const DL_TIMEOUT = Number(process.env.IMWB_DL_TIMEOUT || 5 * 60 * 1000);
const EXT_BY_CT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/wav': '.wav', 'audio/silk': '.silk', 'audio/amr': '.amr' };

export function kindLabel(k) { return k === 'image' ? '图片' : k === 'voice' ? '语音' : k === 'video' ? '视频' : '文件'; }
export function describeAtts(atts) { return (atts || []).map(a => `[${kindLabel(a.kind)}${a.filename ? ':' + a.filename : ''}]`).join(' '); }

export async function saveAttachment(rec, key, { root, sources, max = DL_MAX, timeout = DL_TIMEOUT, download = downloadToFile }) {
  if (!sources?.length) { rec.status = 'failed'; rec.error = '附件没有下载地址'; return rec; }
  if (rec.size != null && rec.size > max) { rec.status = 'too_large'; rec.error = `附件 ${fmtSize(rec.size)} 超过下载上限 ${fmtSize(max)}，未下载`; return rec; }
  const { day, hms } = bjDate();
  const short = crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 6);
  let lastErr;
  for (const s of sources) {
    let base = sanitizeFileName(rec.filename || `${rec.kind}${EXT_BY_CT[(rec.content_type || '').toLowerCase()] || s.ext || ''}`);
    if (s.wav) base = base.replace(/\.(silk|slk|amr)$/i, '') + (/\.wav$/i.test(base) ? '' : '.wav');
    const dest = inboxFilePath(root, day, hms, short, base);
    try {
      const r = await download(s.url, dest, max, timeout, { allowPrivate: s.allowPrivate, transform: s.transform, headers: s.headers });
      Object.assign(rec, { local_path: dest, local_size: r.size, status: 'downloaded', error: null, downloaded_at: new Date().toISOString() });
      if (s.wav) rec.local_format = 'wav';
      if (rec.size == null) rec.size = r.size;
      return rec;
    } catch (e) { lastErr = e; if (/超过/.test(e.message)) { rec.status = 'too_large'; rec.error = e.message; return rec; } }
  }
  rec.status = 'failed'; rec.error = lastErr ? lastErr.message : '下载失败';
  return rec;
}
