// 配置：config.json（不进仓库）→ 规范化的 {port, host, dataDir, accounts:[{id, platform, dir, ...}]}
// 查找顺序：--config 参数 > IMWB_CONFIG 环境变量 > ./config.json
import fs from 'node:fs';
import path from 'node:path';

export const PLATFORMS = ['qq', 'wechat'];
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function configPath(argv = process.argv) {
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return path.resolve(process.env.IMWB_CONFIG || 'config.json');
}

export function normalizeConfig(raw, baseDir, { platforms = PLATFORMS } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('配置必须是 JSON 对象');
  const port = Number(process.env.IMWB_PORT || raw.port || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port 无效：${raw.port}`);
  const host = raw.host || '127.0.0.1';
  const dataDir = path.resolve(baseDir, raw.data_dir || 'data');
  const seen = new Set();
  const accounts = (raw.accounts || []).map((a, i) => {
    if (!a || !ID_RE.test(a.id || '')) throw new Error(`accounts[${i}].id 只能用字母、数字、_、-（最长 64）`);
    if (seen.has(a.id)) throw new Error(`账号 id 重复：${a.id}`);
    seen.add(a.id);
    if (!platforms.includes(a.platform)) throw new Error(`账号 ${a.id} 的 platform 只能是 ${platforms.join(' / ')}`);
    const dir = a.dir ? path.resolve(baseDir, a.dir) : path.join(dataDir, a.id);
    return { ...a, dir, enabled: a.enabled !== false };
  });
  return { port, host, dataDir, accounts, webhook: raw.webhook || {}, file: null };
}

export function loadConfig(file = configPath()) {
  if (!fs.existsSync(file)) throw new Error(`找不到配置文件 ${file}（复制 config.example.json 为 config.json 再改）`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`配置文件不是合法 JSON：${e.message}`); }
  const cfg = normalizeConfig(raw, path.dirname(file));
  cfg.file = file;
  return cfg;
}

export function findAccount(cfg, id) {
  const a = cfg.accounts.find(x => x.id === id);
  if (!a) throw new Error(`配置里没有账号 ${id}（已有：${cfg.accounts.map(x => x.id).join(', ') || '无'}）`);
  return a;
}
