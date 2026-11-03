// 微信入站：iLink 消息 → 收件条目；CDN 媒体下载源（带 AES-128-ECB 解密流）
import crypto from 'node:crypto';
import { mediaKey, decipherStream } from './ilink.js';

const ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };

function mediaRec(kind, obj, extra = {}) {
  const key = mediaKey(obj);
  const param = obj?.media?.encrypt_query_param || null;
  return { kind, content_type: null, filename: null, size: null, local_path: null, status: 'pending', error: null, ...extra,
    // cdn 只存在本机 inbox.jsonl（600），HTTP 接口和 webhook 里会被剥掉
    cdn: param && key ? { param, key: key.toString('hex') } : null };
}

// 返回 null 表示忽略（机器人自己发的消息 message_type=2，或者空消息）
export function buildInboxItem(msg) {
  if (!msg || msg.message_type === 2) return null;
  const from = msg.from_user_id;
  if (!from) return null;
  const texts = [], attachments = [];
  for (const it of msg.item_list || []) {
    if (it.type === ITEM.TEXT && it.text_item?.text != null) texts.push(String(it.text_item.text));
    else if (it.type === ITEM.IMAGE) attachments.push(mediaRec('image', it.image_item, { content_type: 'image/jpeg' }));
    else if (it.type === ITEM.VOICE) {
      const v = it.voice_item || {};
      attachments.push(mediaRec('voice', v, { filename: 'voice.silk', transcript: v.text ? String(v.text).trim() : null, transcript_source: v.text ? 'wechat_asr' : null }));
    } else if (it.type === ITEM.FILE) {
      const f = it.file_item || {};
      attachments.push(mediaRec('file', f, { filename: f.file_name || null, size: f.len != null ? Number(f.len) : null }));
    } else if (it.type === ITEM.VIDEO) attachments.push(mediaRec('video', it.video_item, { content_type: 'video/mp4' }));
  }
  if (!texts.length && !attachments.length) return null;
  for (const a of attachments) if (!a.cdn) { a.status = 'failed'; a.error = '消息里没有 CDN 下载参数或密钥'; }
  const nativeId = msg.message_id != null ? String(msg.message_id)
    : 'h' + crypto.createHash('sha1').update(`${from}|${msg.create_time_ms || msg.create_time || ''}|${JSON.stringify(msg.item_list || [])}`).digest('hex').slice(0, 16);
  const ts = Number(msg.create_time_ms) || (Number(msg.create_time) ? Number(msg.create_time) * 1000 : Date.now());
  return {
    native_id: nativeId, scope: 'c2c', target: from, author: from,
    content: texts.join('\n').trim(), attachments, attachments_ready: attachments.every(a => a.status !== 'pending'),
    mentioned: true, group_id: msg.group_id || undefined, session_id: msg.session_id || undefined,
    msg_ts: ts, received_at: new Date().toISOString(), status: 'pending',
  };
}

export function attachmentSources(rec, ilink) {
  if (!rec.cdn) return [];
  const key = Buffer.from(rec.cdn.key, 'hex');
  const ext = rec.kind === 'image' ? '.jpg' : rec.kind === 'video' ? '.mp4' : '';
  // CDN 地址来自配置（不是消息里任意给的），允许指向测试用的本机 mock
  return [{ url: ilink.downloadUrl(rec.cdn.param), transform: () => decipherStream(key), allowPrivate: true, ext }];
}
