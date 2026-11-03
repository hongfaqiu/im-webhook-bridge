// 收件箱：<account dir>/inbox.jsonl。条目 id 全局唯一：`${account}:${native_id}`。
// status: pending（待处理）/ observed（群里未 @，仅记录）/ done（已处理）
import path from 'node:path';
import { readJSONL, writeJSONL } from '../util.js';

export function createInbox(dir) {
  const F = path.join(dir, 'inbox.jsonl');
  const all = () => readJSONL(F);
  return {
    file: F,
    all,
    find: id => all().find(x => x.id === id) || null,
    has: id => all().some(x => x.id === id),
    append(item) { const a = all(); a.push(item); writeJSONL(F, a); return item; },
    update(id, patch) { const a = all(); const it = a.find(x => x.id === id); if (it) Object.assign(it, patch); writeJSONL(F, a); return it || null; },
    list({ status, limit } = {}) { const a = all().filter(x => !status || x.status === status); return limit ? a.slice(-limit) : a; },
  };
}
