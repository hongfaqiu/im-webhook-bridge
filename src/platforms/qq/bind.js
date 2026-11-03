// QQ 扫码绑定（前台运行）。协议照腾讯官方 @tencent-connect/openclaw-qqbot 2.0.4：
//  POST https://q.qq.com/lite/create_bind_task {key: base64(32 随机字节)} -> data.task_id
//  二维码内容: https://q.qq.com/qqbot/openclaw/connect.html?task_id=..&source=openclaw&_wv=2
//  每 2s POST https://q.qq.com/lite/poll_bind_result {task_id} -> data.status 0 NONE/1 PENDING/2 COMPLETED/3 EXPIRED
//  COMPLETED: data.bot_appid, data.bot_encrypt_secret(base64: iv12 | ciphertext | tag16, AES-256-GCM, key=上面的 key)
// 凭证写到 <account dir>/credentials.json（600），终端和日志里只出现 AppID。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { writeJSON, sleep } from '../../util.js';

const BASE = process.env.IMWB_QQ_BIND_BASE || 'https://q.qq.com';
const POLL_MS = 2000;
const QR_TTL_MS = Number(process.env.IMWB_QR_TTL_MS || 10 * 60 * 1000);
const MAX_TOTAL_MS = Number(process.env.IMWB_BIND_MAX_MS || 60 * 60 * 1000);

export function decryptSecret(encB64, keyB64) {
  const key = Buffer.from(keyB64, 'base64'), buf = Buffer.from(encB64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(buf.length - 16), ct = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function post(p, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(BASE + p, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${p}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function bindQQ({ dir, log, force = false }) {
  const credF = path.join(dir, 'credentials.json');
  if (fs.existsSync(credF) && !force) { log('这个账号已有凭证，跳过（要重绑加 --force）'); return { skipped: true }; }
  const qrPng = path.join(dir, 'bind-qr.png');
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_TOTAL_MS) {
    const key = crypto.randomBytes(32).toString('base64');
    let taskId;
    try {
      const r = await post('/lite/create_bind_task', { key });
      if (r.retcode !== 0 || !r.data?.task_id) throw new Error('create_bind_task: ' + (r.msg || 'missing task_id'));
      taskId = r.data.task_id;
    } catch (e) { log('创建绑定任务失败:', e.message); await sleep(10000); continue; }
    const url = `${BASE}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&source=openclaw&_wv=2`;
    await QRCode.toFile(qrPng, url, { width: 720, margin: 4, errorCorrectionLevel: 'M' });
    try { fs.chmodSync(qrPng, 0o600); } catch {}
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    log(`用手机 QQ 扫码（图片也在 ${qrPng}），${Math.round(QR_TTL_MS / 60000)} 分钟内有效`);
    const qrStart = Date.now();
    while (Date.now() - qrStart < QR_TTL_MS) {
      await sleep(POLL_MS);
      let r;
      try { r = await post('/lite/poll_bind_result', { task_id: taskId }); } catch { continue; }
      if (r.retcode !== 0) continue;
      const st = r.data?.status ?? 0;
      if (st === 3) break;
      if (st === 2) {
        const appSecret = decryptSecret(r.data.bot_encrypt_secret, key);
        const appId = String(r.data.bot_appid || '');
        if (!appId || !appSecret) throw new Error('返回缺少 appid/secret');
        writeJSON(credF, { appId, appSecret, userOpenid: r.data.user_openid || null, boundAt: new Date().toISOString() }, 0o600);
        try { fs.unlinkSync(qrPng); } catch {}
        log('绑定成功，AppID', appId, '凭证已保存（600）');
        return { ok: true, appId };
      }
    }
    log('二维码过期，重新生成');
  }
  throw new Error('超过最长绑定时间，重新运行 bind');
}
