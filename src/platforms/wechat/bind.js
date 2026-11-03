// 微信扫码登录（前台运行）：get_bot_qrcode → 轮询 get_qrcode_status → confirmed 后保存凭证（600）。
// 需要验证码时在终端输入（或 --code 预先给）。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import QRCode from 'qrcode';
import { createIlink, DEFAULT_BASE } from './ilink.js';
import { writeJSON, sleep } from '../../util.js';

const QR_TTL_MS = 5 * 60 * 1000;
const MAX_REFRESH = 6;

export async function bindWechat({ dir, log, force = false, code = null, baseUrl = DEFAULT_BASE, ask }) {
  const credF = path.join(dir, 'credentials.json');
  if (fs.existsSync(credF) && !force) { log('这个账号已有凭证，跳过（要重绑加 --force）'); return { skipped: true }; }
  const askCode = ask || (async () => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question('请输入手机微信上显示的验证码：')).trim(); } finally { rl.close(); }
  });
  const qrPng = path.join(dir, 'bind-qr.png');
  let host = baseUrl;
  for (let round = 1; round <= MAX_REFRESH; round++) {
    const ilink = createIlink({ baseUrl: host });
    const q = await ilink.getBotQrcode([]);
    if (!q.qrcode || !q.qrcode_img_content) throw new Error('get_bot_qrcode 没返回二维码');
    await QRCode.toFile(qrPng, q.qrcode_img_content, { width: 720, margin: 4 });
    try { fs.chmodSync(qrPng, 0o600); } catch {}
    console.log(await QRCode.toString(q.qrcode_img_content, { type: 'terminal', small: true }));
    log(`用手机微信扫码（第 ${round}/${MAX_REFRESH} 张，图片也在 ${qrPng}），5 分钟内有效`);
    const t0 = Date.now(); let verify = code; let pollHost = host;
    while (Date.now() - t0 < QR_TTL_MS) {
      let s;
      try { s = await createIlink({ baseUrl: pollHost }).getQrcodeStatus(q.qrcode, verify); }
      catch (e) { if (e.name === 'AbortError') continue; log('查询扫码状态失败:', e.message); await sleep(2000); continue; }
      switch (s.status) {
        case 'wait': break;
        case 'scaned': log('已扫码，请在手机上确认'); break;
        case 'scaned_but_redirect':
        case 'binded_redirect':
          if (s.redirect_host) { pollHost = /^https?:\/\//.test(s.redirect_host) ? s.redirect_host : `https://${s.redirect_host}`; log('服务端要求切换节点，继续等待确认'); }
          else if (s.status === 'binded_redirect') throw new Error('这个微信已经绑定在别处（binded_redirect）');
          break;
        case 'need_verifycode': verify = await askCode(); break;
        case 'verify_code_blocked': throw new Error('验证码错误次数过多，已被暂时锁定，稍后再试');
        case 'expired': log('二维码过期'); break;
        case 'confirmed': {
          if (!s.bot_token || !s.ilink_bot_id) throw new Error('confirmed 但缺少 bot_token / ilink_bot_id');
          writeJSON(credF, { token: s.bot_token, accountId: s.ilink_bot_id, baseUrl: s.baseurl || pollHost, userId: s.ilink_user_id || null, savedAt: new Date().toISOString() }, 0o600);
          try { fs.unlinkSync(path.join(dir, 'sync_buf')); } catch {}
          try { fs.unlinkSync(qrPng); } catch {}
          log('绑定成功，bot id', s.ilink_bot_id, '凭证已保存（600）');
          return { ok: true, accountId: s.ilink_bot_id };
        }
        default: log('未知扫码状态', s.status);
      }
      if (s.status === 'expired') break;
      if (s.status !== 'wait') await sleep(1000);
    }
  }
  throw new Error(`二维码已刷新 ${MAX_REFRESH} 次仍未完成，重新运行 bind`);
}
