// 账号锁：data/<account>/account.lock 里写持有者 PID。
// 同一个账号绝不能被两个进程同时连接（QQ 会互踢，微信会抢 getupdates 游标）。
import fs from 'node:fs';
import path from 'node:path';
import { pidAlive } from '../util.js';

export function acquireLock(dir, name = 'account.lock') {
  const f = path.join(dir, name);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(f, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      let released = false;
      return {
        file: f,
        release() {
          if (released) return; released = true;
          try { const cur = JSON.parse(fs.readFileSync(f, 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(f); } catch {}
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(f, 'utf8')).pid; } catch {}
      if (holder && (holder === process.pid || pidAlive(holder))) {
        const err = new Error(`账号已被进程 PID ${holder} 占用（${f}）`); err.code = 'LOCKED'; err.pid = holder; throw err;
      }
      try { fs.unlinkSync(f); } catch {} // 旧进程已不在：清掉陈旧锁再试一次
    }
  }
  throw new Error(`拿不到锁 ${f}`);
}
