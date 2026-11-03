// 统一服务：一个进程跑配置里的所有账号，共用一个 HTTP 端口
import http from 'node:http';
import { makeLogger, VERSION } from '../util.js';
import { createAccount } from './account.js';
import { createHandler } from './http.js';
import { makeForbidden } from './media.js';

export async function defaultFactories() {
  const { createQQ } = await import('../platforms/qq/index.js');
  const { createWechat } = await import('../platforms/wechat/index.js');
  return { qq: createQQ, wechat: createWechat };
}

export function createService(cfg, { factories, fatal, log = makeLogger('bridge'), downloadOpts } = {}) {
  const accounts = new Map();
  for (const acc of cfg.accounts) {
    const f = factories[acc.platform];
    if (!f) throw new Error(`不支持的平台 ${acc.platform}`);
    accounts.set(acc.id, createAccount({ cfg, acc, factory: f, fatal: fatal || ((m, id) => { log(`[${id}] 致命错误：${m}，退出交给守护进程重启`); process.exit(1); }), log: makeLogger(acc.id), downloadOpts }));
  }
  const forbidden = makeForbidden([cfg.dataDir, ...cfg.accounts.map(a => a.dir)]);
  const svc = { cfg, accounts, version: VERSION, started_at: new Date().toISOString(), forbidden, server: null };
  svc.handler = createHandler(svc);

  svc.start = function start() {
    const started = [];
    try { for (const a of accounts.values()) { a.start(); started.push(a); } }
    catch (e) { for (const a of started) a.stop(); throw e; }
    return svc;
  };
  svc.listen = function listen(port = cfg.port, host = cfg.host) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(svc.handler);
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); svc.server = server; log(`HTTP 监听 http://${host}:${server.address().port}，账号 ${[...accounts.keys()].join(', ') || '（无）'}`); resolve(server); });
    });
  };
  svc.stop = async function stop() {
    if (svc.server) await new Promise(r => svc.server.close(() => r()));
    await Promise.all([...accounts.values()].map(a => a.stop().catch(() => {})));
  };
  return svc;
}
