// HTTP 接口（默认只监听 127.0.0.1）。所有消息都带 platform / account；/reply 按消息 id 自动路由到对应账号。
import { URL } from 'node:url';
import { publicItem } from './account.js';
import { resolveFileSpec } from './media.js';

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('请求体超过 1MB'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const accountOfId = id => String(id || '').split(':')[0];

export function createHandler(svc) {
  const { accounts } = svc;
  function pick(q, { required = false } = {}) {
    const id = q.account;
    if (!id) { if (required) throw bad('需要 account'); return [...accounts.values()]; }
    const a = accounts.get(id); if (!a) throw bad(`没有账号 ${id}`, 404); return [a];
  }
  function byMsgId(id) {
    if (!id) throw bad('需要 id');
    const a = accounts.get(accountOfId(id)); if (!a) throw bad(`消息 id 不属于任何账号：${id}`, 404);
    const it = a.inbox.find(id); if (!it) throw bad(`收件箱里没有 ${id}`, 404);
    return { a, it };
  }
  const running = a => { if (!a.platform || a.state.state !== 'running') throw bad(`账号 ${a.id} 未运行（${a.state.state}）`, 409); };
  function collect(list, q, fn) {
    let out = list.flatMap(fn).sort((x, y) => String(x.received_at || x.created_at).localeCompare(String(y.received_at || y.created_at)));
    if (q.platform) out = out.filter(x => x.platform === q.platform);
    const limit = Number(q.limit) || 0; if (limit) out = out.slice(-limit);
    return out;
  }

  const routes = {
    'GET /health': (q) => {
      const accs = pick(q).map(a => a.health());
      return { ok: accs.length > 0 && accs.every(x => x.ok || x.state === 'disabled'), version: svc.version, pid: process.pid, started_at: svc.started_at, accounts: accs };
    },
    'GET /pending': q => { const items = collect(pick(q), q, a => a.inbox.list({ status: 'pending' }).map(publicItem)); return { count: items.length, items }; },
    'GET /inbox': q => { const items = collect(pick(q), q, a => a.inbox.list({ status: q.status }).map(publicItem)); return { count: items.length, items }; },
    'POST /ack': (q, b) => {
      const ids = Array.isArray(b.ids) ? b.ids : [b.id];
      const done = ids.map(id => { const { a } = byMsgId(id); a.inbox.update(id, { status: 'done', done_at: new Date().toISOString() }); return id; });
      return { ok: true, acked: done };
    },
    'POST /reply': async (q, b) => {
      let a, it = null, scope, target;
      if (b.id) { ({ a, it } = byMsgId(b.id)); scope = it.scope; target = it.target; }
      else {
        if (!b.account || !b.target) throw bad('需要 id（回复某条消息），或者 account + target（+ scope）主动发送');
        a = pick({ account: b.account })[0]; scope = b.scope || 'c2c'; target = String(b.target);
      }
      running(a);
      if (!a.platform.scopes.includes(scope)) throw bad(`${a.platformName} 不支持 scope ${scope}`);
      const content = b.content != null ? String(b.content) : '';
      const filesIn = Array.isArray(b.files) ? b.files : b.files ? [b.files] : [];
      if (!content.trim() && !filesIn.length) throw bad('content 和 files 至少要有一个');
      const v = a.platform.validateReply({ scope, files: filesIn }); if (v) throw bad(v);
      const files = [];
      for (const f of filesIn) { try { files.push(await resolveFileSpec(f, { limits: a.platform.sendLimits, forbidden: svc.forbidden })); } catch (e) { throw bad(e.message); } }
      const queued = a.outbox.enqueue({ scope, target, content, files, reply_to: it?.native_id, reply_ts: it?.msg_ts, inbox_id: it?.id, markdown: b.markdown, quote: b.quote });
      if (it && b.done !== false) a.inbox.update(it.id, { status: 'done', done_at: new Date().toISOString() });
      return { ok: true, account: a.id, platform: a.platformName, queued: queued.map(x => ({ id: x.id, kind: x.kind, part: x.part, parts: x.parts, ...(x.media?.notes?.length ? { notes: x.media.notes } : {}) })) };
    },
    'GET /outbox': q => { const items = collect(pick(q).filter(a => a.outbox), q, a => a.outbox.list(q.status)); return { count: items.length, items }; },
    'POST /outbox/retry': (q, b) => {
      const list = b.id ? pick({ account: accountOfId(b.id) }) : pick({ account: b.account });
      // outbox id 形如 <account>:o...，找到它所在的账号
      let n = 0; for (const a of list) if (a.outbox) n += a.outbox.retry(b.id);
      return { ok: true, requeued: n };
    },
    'POST /typing': async (q, b) => {
      const { a, it } = byMsgId(b.id); running(a);
      if (!a.platform.typing) throw bad(`${a.platformName} 不支持 typing`);
      await a.platform.typing(it, b.seconds); return { ok: true };
    },
    'POST /recall': async (q, b) => {
      const a = accounts.get(accountOfId(b.outbox_id)); if (!a?.outbox) throw bad('没有这个 outbox_id', 404);
      running(a);
      const it = a.outbox.find(b.outbox_id); if (!it?.sent_msg_id) throw bad('这条还没发出去或没有消息 id');
      if (!a.platform.recall) throw bad(`${a.platformName} 不支持撤回`);
      await a.platform.recall(it); it.recalled_at = new Date().toISOString(); a.outbox.save(it); return { ok: true };
    },
    'GET /known': q => ({ accounts: pick(q).filter(a => a.platform?.known).map(a => ({ account: a.id, platform: a.platformName, known: a.platform.known() })) }),
    'GET /events': q => { const [a] = pick(q, { required: true }); if (!a.platform?.events) throw bad('这个平台没有事件日志'); return { items: a.platform.events(Number(q.limit) || 50) }; },
    'GET /ref': q => { const [a] = pick(q, { required: true }); if (!a.platform?.ref) throw bad('这个平台没有引用索引'); return { item: a.platform.ref(q.k) || null }; },
  };

  return async function handler(req, res) {
    try {
      const u = new URL(req.url, 'http://x');
      const fn = routes[`${req.method} ${u.pathname.replace(/\/+$/, '') || '/'}`];
      if (!fn) return send(res, 404, { ok: false, error: '没有这个接口', endpoints: Object.keys(routes) });
      const q = Object.fromEntries(u.searchParams);
      const b = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await fn(q, b));
    } catch (e) { send(res, e.status || 500, { ok: false, error: e.message }); }
  };
}
