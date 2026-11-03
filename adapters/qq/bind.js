'use strict';
// 扫码快速绑定。协议照腾讯官方 @tencent-connect/openclaw-qqbot 2.0.4
// (内置 @tencent-connect/qqbot-connector qqbot-session.js / qr-connect.js)：
//  POST https://q.qq.com/lite/create_bind_task {key: base64(32 随机字节)} -> data.task_id
//  二维码内容: https://q.qq.com/qqbot/openclaw/connect.html?task_id=..&source=openclaw&_wv=2
//  每 2s POST https://q.qq.com/lite/poll_bind_result {task_id} -> data.status 0 NONE/1 PENDING/2 COMPLETED/3 EXPIRED
//  COMPLETED: data.bot_appid, data.bot_encrypt_secret(base64: iv12 | ciphertext | tag16, AES-256-GCM, key=上面的 key), data.user_openid
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { P, PORT, HOST, makeLogger, writeJSON, readJSON, hasCreds, ROOT } = require('./lib');
const log = makeLogger('bind');
const HOSTNAME = 'q.qq.com';
const POLL_MS = 2000;
const QR_TTL_MS = Number(process.env.QQBOT_QR_TTL_MS || 10 * 60 * 1000); // 本地兜底：10 分钟没结果就换码
const MAX_TOTAL_MS = Number(process.env.QQBOT_BIND_MAX_MS || 2 * 60 * 60 * 1000); // 最多持续 2 小时

const status = { state: 'starting', pid: process.pid, started_at: new Date().toISOString(), qr_png: P.qr, qr_url: null,
  qr_generated_at: null, qr_expires_at: null, qr_count: 0, last_poll_status: null, last_poll_at: null, last_error: null, bound_app_id: null, completed_at: null };
function saveStatus() { try { writeJSON(P.bindStatus, status); } catch {} }

function post(path, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname: HOSTNAME, path, method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${path}`)); }
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + path)); });
    req.end(data);
  });
}
function decrypt(encB64, keyB64) {
  const key = Buffer.from(keyB64, 'base64'), buf = Buffer.from(encB64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(buf.length - 16), ct = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 绑定期间在 8787 提供 /bind/status 和 /health（gateway 未启动时）
let server = null;
function startServer() {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (u.pathname === '/bind/status') return res.end(JSON.stringify(status));
    if (u.pathname === '/health') return res.end(JSON.stringify({ ok: false, mode: 'binding', ws: 'not_started', bind: status.state, qr_expires_at: status.qr_expires_at }));
    res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: 'binding in progress; gateway not started', bind: status.state }));
  });
  server.on('error', e => log('本地接口未启动（端口占用？）:', e.message));
  server.listen(PORT, HOST);
}

async function main() {
  if (hasCreds() && !process.argv.includes('--force')) { log('已有凭证，跳过绑定（要重绑用 --force）'); return; }
  saveStatus(); startServer();
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_TOTAL_MS) {
    let task;
    try {
      const key = crypto.randomBytes(32).toString('base64');
      const r = await post('/lite/create_bind_task', { key });
      if (r.retcode !== 0 || !r.data?.task_id) throw new Error('create_bind_task: ' + (r.msg || 'missing task_id'));
      task = { id: r.data.task_id, key };
    } catch (e) { status.state = 'error'; status.last_error = e.message; saveStatus(); log('创建绑定任务失败:', e.message); await sleep(10000); continue; }
    const url = `https://${HOSTNAME}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(task.id)}&source=openclaw&_wv=2`;
    await QRCode.toFile(P.qr + '.tmp.png', url, { width: 720, margin: 4, errorCorrectionLevel: 'M' });
    fs.renameSync(P.qr + '.tmp.png', P.qr);
    status.qr_count++; status.qr_url = url; status.qr_generated_at = new Date().toISOString();
    status.qr_expires_at = new Date(Date.now() + QR_TTL_MS).toISOString(); status.state = 'waiting_scan'; status.last_error = null; saveStatus();
    log(`二维码已生成 #${status.qr_count} -> ${P.qr}`);
    const qrStart = Date.now();
    let outcome = null;
    while (!outcome) {
      if (Date.now() - qrStart > QR_TTL_MS) { outcome = 'expired'; break; }
      await sleep(POLL_MS);
      let r;
      try { r = await post('/lite/poll_bind_result', { task_id: task.id }); }
      catch (e) { status.last_error = e.message; saveStatus(); continue; }
      if (r.retcode !== 0) { status.last_error = 'poll: ' + (r.msg || r.retcode); saveStatus(); continue; }
      const st = r.data?.status ?? 0;
      status.last_poll_status = ['NONE', 'PENDING', 'COMPLETED', 'EXPIRED'][st] || String(st); status.last_poll_at = new Date().toISOString();
      // 官方状态：0 NONE / 1 PENDING（等待扫码/确认）/ 2 COMPLETED / 3 EXPIRED
      saveStatus();
      if (st === 3) outcome = 'expired';
      if (st === 2) {
        try {
          const appSecret = decrypt(r.data.bot_encrypt_secret, task.key);
          const appId = String(r.data.bot_appid || '');
          if (!appId || !appSecret) throw new Error('返回缺少 appid/secret');
          writeJSON(P.creds, { appId, appSecret, userOpenid: r.data.user_openid || null, boundAt: new Date().toISOString() }, 0o600);
          fs.chmodSync(P.creds, 0o600);
          status.state = 'completed'; status.bound_app_id = appId; status.completed_at = new Date().toISOString(); saveStatus();
          log('绑定成功，AppID', appId, '凭证已保存到 data/credentials.json');
          outcome = 'completed';
        } catch (e) { status.state = 'error'; status.last_error = '解密/保存失败: ' + e.message; saveStatus(); log(status.last_error); outcome = 'expired'; }
      }
    }
    if (outcome === 'completed') {
      try { fs.unlinkSync(P.qr); } catch {}
      await new Promise(r => server.close(() => r()));
      const child = spawn('bash', [`${ROOT}/start.sh`], { detached: true, stdio: 'ignore' }); // detached 即 setsid（macOS 没有 setsid 命令）
      child.unref();
      log('已后台调用 start.sh 启动 gateway');
      return;
    }
    status.state = 'expired_regenerating'; saveStatus(); log('二维码过期，重新生成');
  }
  status.state = 'gave_up'; status.last_error = '超过最长绑定时间，重新跑 bash start.sh 或 node bind.js'; saveStatus();
  server.close();
}
main().catch(e => { status.state = 'error'; status.last_error = e.message; saveStatus(); log('致命错误:', e.message); process.exit(1); });
