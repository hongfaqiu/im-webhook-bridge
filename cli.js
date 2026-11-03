#!/usr/bin/env node
// im-webhook-bridge 命令行
//   node cli.js start                      启动服务（所有账号，一个进程一个端口）
//   node cli.js bind <account> [--force] [--code 123456]   前台扫码绑定一个账号
//   node cli.js check                      校验 config.json，列出账号和绑定状态（不打印任何密钥）
//   node cli.js health                     请求本机 /health
//   node cli.js import <account> <旧数据目录> [--force]   从旧版单账号安装复制凭证/会话文件（600），不打印内容
// 所有命令都接受 --config <file>（默认 ./config.json，或 IMWB_CONFIG）
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, findAccount } from './src/core/config.js';
import { createService, defaultFactories } from './src/core/service.js';
import { makeLogger, ensureDir, VERSION } from './src/util.js';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--config', '--code', '--account'].includes(argv[i - 1])));
const cmd = pos[0] || 'help';
const log = makeLogger('cli');
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

// 旧版单账号安装里可以迁移的文件（只复制这些，其他一概不碰）
const IMPORT_FILES = {
  qq: ['credentials.json', 'session.json', 'webhook_url', 'webhook_key', 'known-users.json', 'upload-cache.json'],
  wechat: ['credentials.json', 'sync_buf', 'contexts.json', 'webhook_url', 'webhook_key'],
};

async function main() {
  const cfg = (() => { try { return loadConfig(opt('config') ? path.resolve(opt('config')) : undefined); } catch (e) { if (cmd === 'help') return null; die(e.message, 2); } })();
  switch (cmd) {
    case 'start': {
      if (!cfg.accounts.length) die('config.json 里没有账号', 2);
      const svc = createService(cfg, { factories: await defaultFactories() });
      try { svc.start(); } catch (e) { die(e.code === 'LOCKED' ? `另一个实例在跑：${e.message}` : e.message, e.code === 'LOCKED' ? 3 : 1); }
      try { await svc.listen(); } catch (e) {
        await svc.stop();
        if (e.code === 'EADDRINUSE') die(`端口 ${cfg.host}:${cfg.port} 已被占用`, 3);
        throw e;
      }
      log(`im-webhook-bridge ${VERSION} 已启动 PID ${process.pid}`);
      let stopping = false;
      const bye = sig => { if (stopping) return; stopping = true; log(`收到 ${sig}，正在停止`); svc.stop().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
      process.on('SIGTERM', () => bye('SIGTERM')); process.on('SIGINT', () => bye('SIGINT'));
      return;
    }
    case 'bind': {
      const acc = findAccount(cfg, pos[1] || die('用法：node cli.js bind <account> [--force]', 2));
      ensureDir(acc.dir);
      const f = (await defaultFactories())[acc.platform];
      const p = f({ account: acc.id, dir: acc.dir, log: makeLogger(`${acc.id}/bind`), options: acc, onMessage: () => null, wakeOutbox: () => 0, fatal: m => die(m) });
      const r = await p.bind({ force: flag('force'), code: opt('code') });
      if (!r?.skipped) console.log(`绑定完成。服务在跑的话约 10 秒内自动上线；没在跑就 node cli.js start（或 bash deploy/install.sh）`);
      process.exit(0);
    }
    case 'check': {
      console.log(`配置：${cfg.file}\n端口：${cfg.host}:${cfg.port}\n数据目录：${cfg.dataDir}`);
      const g = ['webhook_url', 'webhook_key'].every(n => fs.existsSync(path.join(cfg.dataDir, n)));
      console.log(`全局 webhook：${g ? '已配置' : '未配置'}`);
      for (const a of cfg.accounts) {
        const bound = fs.existsSync(path.join(a.dir, 'credentials.json'));
        const wh = ['webhook_url', 'webhook_key'].every(n => fs.existsSync(path.join(a.dir, n)));
        console.log(`- ${a.id}  ${a.platform}  ${a.enabled ? '' : '(已停用) '}${bound ? '已绑定' : '未绑定'}  webhook:${wh ? '账号自己的' : g ? '用全局' : '无'}  ${a.dir}`);
      }
      return;
    }
    case 'health': {
      const r = await fetch(`http://127.0.0.1:${cfg.port}/health${opt('account') ? `?account=${encodeURIComponent(opt('account'))}` : ''}`).catch(e => die(`连不上 127.0.0.1:${cfg.port}：${e.cause?.code || e.message}`));
      console.log(await r.text()); process.exit(r.ok ? 0 : 1);
    }
    case 'import': {
      const acc = findAccount(cfg, pos[1] || die('用法：node cli.js import <account> <旧数据目录>', 2));
      const src = pos[2] ? path.resolve(pos[2]) : die('需要旧数据目录', 2);
      if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory()) die(`不是目录：${src}`, 2);
      ensureDir(acc.dir);
      for (const n of IMPORT_FILES[acc.platform]) {
        const from = path.join(src, n), to = path.join(acc.dir, n);
        if (!fs.existsSync(from)) { console.log(`  跳过 ${n}（旧目录没有）`); continue; }
        if (fs.existsSync(to) && !flag('force')) { console.log(`  跳过 ${n}（新目录已有，覆盖加 --force）`); continue; }
        fs.copyFileSync(from, to); fs.chmodSync(to, 0o600); console.log(`  已复制 ${n}（600）`);
      }
      return;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 8).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}
main().catch(e => die(e.stack || e.message));
