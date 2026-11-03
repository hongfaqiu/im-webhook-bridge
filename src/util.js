// 公共工具：JSON / JSONL 文件、日志脱敏、北京时间
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '3.0.0';

export function nowCN() { return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }

// 日志里绝不出现凭证：常见字段名、Authorization 头、QQBot token
export function redact(s) {
  return String(s)
    .replace(/("?(?:appSecret|clientSecret|access_token|bot_encrypt_secret|bot_token|context_token|token|key|aes_key|aeskey)"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"')
    .replace(/QQBot\s+[A-Za-z0-9._\-]+/g, 'QQBot ***')
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=@:]+/g, 'Bearer ***');
}

export function makeLogger(name) {
  return (...a) => {
    console.log(`[${nowCN()}] [${name}] ` + redact(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')));
  };
}

export function ensureDir(d, mode = 0o700) {
  fs.mkdirSync(d, { recursive: true, mode });
  try { fs.chmodSync(d, mode); } catch {}
  return d;
}

export function readJSON(f, dflt = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }

export function writeJSON(f, obj, mode = 0o600) {
  const tmp = `${f}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, f);
}

export function readJSONL(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function writeJSONL(f, arr) {
  const tmp = `${f}.tmp${process.pid}`;
  fs.writeFileSync(tmp, arr.map(x => JSON.stringify(x)).join('\n') + (arr.length ? '\n' : ''), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
}

export function appendJSONL(f, obj) { fs.appendFileSync(f, JSON.stringify(obj) + '\n', { mode: 0o600 }); }

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// 北京日期，用于附件按天分目录
export function bjDate() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hms: `${g('hour')}${g('minute')}${g('second')}`.replace(/^24/, '00') };
}

export function pidAlive(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function chmod600(f) { try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch {} }

export function rel(root, p) { return path.relative(root, p) || '.'; }
