// 微信发送：文字 / 图片 / 视频 / 文件（语音一律按文件发）。媒体先 AES-128-ECB 加密上传 CDN，再发消息。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aesEncrypt, cipherSize, MEDIA_TYPE } from './ilink.js';
import { downloadToFile, MB } from '../../core/media.js';

export const HARD_MAX = Number(process.env.IMWB_WECHAT_SEND_MAX || 100 * MB);
export const TYPE_LIMIT = { image: 30 * MB, video: 100 * MB, voice: 20 * MB, file: 100 * MB };

export const textItem = text => ({ type: 1, text_item: { text } });

export async function uploadToCdn(ilink, to, buf, type) {
  const mediaType = MEDIA_TYPE[type] || MEDIA_TYPE.file;
  const key = crypto.randomBytes(16);
  const filekey = crypto.randomBytes(16).toString('hex');
  const rawsize = buf.length;
  const cipher = aesEncrypt(buf, key);
  const resp = await ilink.getUploadUrl({
    filekey, media_type: mediaType, to_user_id: to, rawsize, rawfilemd5: crypto.createHash('md5').update(buf).digest('hex'),
    filesize: cipherSize(rawsize), no_need_thumb: true, aeskey: key.toString('hex'),
  });
  const url = resp.upload_full_url || (resp.upload_param ? ilink.uploadUrl(resp.upload_param, filekey) : null);
  if (!url) throw new Error('getuploadurl 没返回上传地址');
  const param = await ilink.uploadCdn(url, cipher);
  return { media: { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, rawsize, filesize: cipher.length };
}

export function mediaItem(type, up, name) {
  if (type === 'image') return { type: 2, image_item: { media: up.media, mid_size: up.filesize } };
  if (type === 'video') return { type: 5, video_item: { media: up.media, video_size: up.filesize } };
  return { type: 4, file_item: { media: up.media, file_name: name, len: String(up.rawsize) } };
}

// 读出要发的文件内容（URL 先下载到账号 tmp/）
export async function loadSpec(spec, tmpDir) {
  if (spec.source === 'path') {
    if (!fs.existsSync(spec.path)) throw new Error(`文件不存在：${spec.path}`);
    return fs.promises.readFile(spec.path);
  }
  const tmp = path.join(tmpDir, `dl_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
  try { await downloadToFile(spec.url, tmp, HARD_MAX, 300000); return await fs.promises.readFile(tmp); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
