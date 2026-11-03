'use strict';
// 公共工具：路径、JSON 文件、日志（日志里绝不写凭证）
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const LOGS = path.join(ROOT, 'logs');
const P = {
  creds: path.join(DATA, 'credentials.json'),
  bindStatus: path.join(DATA, 'bind-status.json'),
  inbox: path.join(DATA, 'inbox.jsonl'),
  outbox: path.join(DATA, 'outbox.jsonl'),
  session: path.join(DATA, 'session.json'),
  qr: path.join(ROOT, 'bind-qr.png'),
};
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
fs.mkdirSync(LOGS, { recursive: true });
const PORT = Number(process.env.QQBOT_PORT || 8787);
const HOST = '127.0.0.1';
function nowCN() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function redact(s) {
  return String(s)
    .replace(/("?(?:appSecret|clientSecret|access_token|bot_encrypt_secret|token|key)"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"')
    .replace(/QQBot\s+[A-Za-z0-9._\-]+/g, 'QQBot ***');
}
function makeLogger(name) {
  return (...a) => {
    const line = `[${nowCN()}] [${name}] ` + redact(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
    console.log(line);
  };
}
function readJSON(f, dflt = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function writeJSON(f, obj, mode) {
  const tmp = f + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: mode || 0o644 });
  if (mode) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, f);
}
function readJSONL(f) {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function writeJSONL(f, arr) {
  const tmp = f + '.tmp' + process.pid;
  fs.writeFileSync(tmp, arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : ''), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
}
function hasCreds() { const c = readJSON(P.creds); return !!(c && c.appId && c.appSecret); }
module.exports = { ROOT, DATA, LOGS, P, PORT, HOST, nowCN, makeLogger, readJSON, writeJSON, readJSONL, writeJSONL, hasCreds };
