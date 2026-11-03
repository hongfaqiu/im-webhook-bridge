// 发件队列：<account dir>/outbox.jsonl，平台无关的重试 / 退避 / 等待上下文。
// 状态：pending → sent | failed | waiting_context（微信：没有可用 context_token，等对方再发一条消息后自动续发）
// 平台只需要实现：
//   send(it)          → 发一条（文字分段已由这里切好）；返回 { sent_msg_id?, ... }，失败抛错
//   onSendError(it,e) → 可改写 it 做降级（markdown→纯文本、被动→主动…）；返回 'failed' | 'waiting' | undefined
import crypto from 'node:crypto';
import path from 'node:path';
import { readJSONL, writeJSONL } from '../util.js';

export const MAX_ATTEMPTS = 12;
export const backoffMs = n => (n <= 1 ? 1000 : Math.min(30 * 60 * 1000, 2000 * 2 ** (n - 1)));

export function splitText(s, limit = 1800) {
  const out = []; let t = String(s);
  while (t.length > limit) { let cut = t.lastIndexOf('\n', limit); if (cut < limit * 0.5) cut = limit; out.push(t.slice(0, cut)); t = t.slice(cut).replace(/^\n/, ''); }
  if (t) out.push(t);
  return out;
}
const newId = i => 'o_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex') + '_' + i;

export function createOutbox({ dir, account, platform, log = () => {}, onSent = () => {}, intervalMs = 3000, maxAttempts = MAX_ATTEMPTS }) {
  const F = path.join(dir, 'outbox.jsonl');
  const all = () => readJSONL(F);
  let draining = false, again = false, timer = null, stopped = false;
  const stats = { sent: 0 };

  function save(it) { const a = all(); const i = a.findIndex(x => x.id === it.id); if (i >= 0) a[i] = it; else a.push(it); writeJSONL(F, a); }

  // content 先发（按平台长度分段），files 逐个跟在后面
  function enqueue({ scope, target, content, files, reply_to, reply_ts, inbox_id, markdown, quote, extra }) {
    const a = all();
    const base = { account, platform: platform.name, scope, target, reply_to: reply_to || null, reply_ts: reply_ts || null, inbox_id: inbox_id || null, ...(extra || {}),
      status: 'pending', attempts: 0, next_at: Date.now(), created_at: new Date().toISOString(), last_error: null };
    const parts = content ? splitText(content, platform.textLimit || 1800) : [];
    const total = parts.length + (files || []).length; let k = 0;
    const items = [];
    parts.forEach((c, i) => items.push({ ...base, id: `${account}:${newId(k)}`, kind: 'text', content: c, markdown: !!markdown, quote: !!quote && i === 0, part: ++k, parts: total }));
    (files || []).forEach(f => items.push({ ...base, id: `${account}:${newId(k)}`, kind: 'media', media: f, part: ++k, parts: total }));
    a.push(...items); writeJSONL(F, a); kick();
    return items;
  }

  async function drain() {
    if (stopped) return;
    if (draining) { again = true; return; }
    draining = true;
    try {
      do {
        again = false;
        const due = all().filter(x => x.status === 'pending' && x.next_at <= Date.now());
        for (const d of due) {
          if (stopped) break;
          const it = all().find(x => x.id === d.id);
          if (!it || it.status !== 'pending') continue;
          try {
            const r = await platform.send(it);
            Object.assign(it, { status: 'sent', sent_at: new Date().toISOString(), sent_msg_id: r?.sent_msg_id || null, last_error: null });
            delete it.stage; stats.sent++;
            try { onSent(it, r); } catch {}
          } catch (e) {
            it.attempts++; it.last_error = String(e.message || e).slice(0, 500);
            let verdict;
            try { verdict = platform.onSendError ? platform.onSendError(it, e) : undefined; } catch (e2) { log('onSendError 异常', e2.message); }
            if (verdict === 'failed') it.status = 'failed';
            else if (verdict === 'waiting') { it.status = 'waiting_context'; it.waiting_since = new Date().toISOString(); it.next_at = null; }
            else if (it.attempts >= maxAttempts) it.status = 'failed';
            else it.next_at = Date.now() + backoffMs(it.attempts);
            log('发送失败', it.id, it.kind, `attempt ${it.attempts}`, it.status !== 'pending' ? `→ ${it.status}` : '', it.last_error);
          }
          save(it);
        }
      } while (again && !stopped);
    } catch (e) { log('drain error', e.message); }
    finally { draining = false; }
  }
  function kick() { if (!stopped) setImmediate(drain); }

  // 微信：对方来了新消息（拿到新 context_token）→ 把等待中的发给他的条目放回队列
  function wake(target) {
    const a = all(); let n = 0;
    for (const x of a) if (x.status === 'waiting_context' && (!target || x.target === target)) { x.status = 'pending'; x.attempts = 0; x.next_at = Date.now(); n++; }
    if (n) { writeJSONL(F, a); log(`${n} 条等待上下文的消息重新入队`); kick(); }
    return n;
  }
  // /outbox/retry：failed 和 waiting_context 都放回去；force_active 让 QQ 直接走主动消息
  function retry(id) {
    const a = all(); let n = 0;
    for (const x of a) if ((x.status === 'failed' || x.status === 'waiting_context') && (!id || x.id === id)) { x.status = 'pending'; x.attempts = 0; x.next_at = Date.now(); x.force_active = true; n++; }
    if (n) { writeJSONL(F, a); kick(); }
    return n;
  }
  function list(status) { return all().filter(x => !status || x.status === status); }
  function counts() {
    const c = { pending: 0, sent: 0, failed: 0, waiting_context: 0 };
    for (const x of all()) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }
  function start() { stopped = false; timer = setInterval(drain, intervalMs); timer.unref?.(); kick(); }
  function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; }
  return { file: F, enqueue, drain, wake, retry, list, counts, find: id => all().find(x => x.id === id) || null, save, start, stop, stats, _busy: () => draining };
}
