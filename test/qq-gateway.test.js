// QQ 端到端：mock token / OpenAPI / WebSocket 网关，走一遍 identify → READY → 收 C2C → 自动回执 + 被动回复
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { normalizeConfig } from '../src/core/config.js';
import { createService } from '../src/core/service.js';
import { createQQ } from '../src/platforms/qq/index.js';
import { serve, tmpdir, readBody, until } from './helpers.js';

const st = { posts: [], identify: null, tokenReqs: 0 };
let wsBase;
const M = await serve(async (req, res) => {
  const body = (await readBody(req)).toString();
  const json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  if (req.url === '/app/getAppAccessToken') { st.tokenReqs++; return json({ access_token: 'TK' + st.tokenReqs, expires_in: 7200 }); }
  if (req.url === '/gateway') return json({ url: wsBase });
  if (req.method === 'POST' && req.url.startsWith('/v2/')) { st.posts.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); return json({ id: 'SENT' + st.posts.length, timestamp: 1 }); }
  res.statusCode = 404; res.end('{}');
});
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise(r => wss.once('listening', r));
wsBase = `ws://127.0.0.1:${wss.address().port}`;
let sock;
wss.on('connection', s => {
  sock = s;
  s.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  s.on('message', raw => {
    const p = JSON.parse(raw.toString());
    if (p.op === 2) { st.identify = p.d; s.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'SESS', user: { id: 'BOT1', username: 'testbot' } } })); }
    if (p.op === 1) s.send(JSON.stringify({ op: 11 }));
  });
});
const root = tmpdir('imwb-qqgw-');
let svc, B;
after(async () => { await svc?.stop(); sock?.terminate(); await new Promise(r => wss.close(r)); await M.close(); fs.rmSync(root, { recursive: true, force: true }); });
const api = async (p, b) => { const r = await fetch(B + p, b ? { method: 'POST', body: JSON.stringify(b) } : undefined); return { status: r.status, body: await r.json() }; };

test('identify → READY → 收消息 → 自动回执 + 被动回复', { timeout: 15000 }, async () => {
  const cfg = normalizeConfig({ accounts: [{ id: 'q1', platform: 'qq', api_base: M.base, token_base: M.base }] }, root);
  const dir = path.join(root, 'data', 'q1'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ appId: 'APPTEST', appSecret: 'SECRET' }), { mode: 0o600 });
  svc = createService(cfg, { factories: { qq: createQQ }, fatal: m => { throw new Error(m); }, log: () => {} });
  svc.start(); const s = await svc.listen(0, '127.0.0.1'); B = `http://127.0.0.1:${s.address().port}`;
  await until(async () => (await api('/health')).body.accounts[0].ws === 'ready', 8000);
  assert.equal(st.identify.token, 'QQBot TK1');
  assert.equal(st.identify.intents, (1 << 25) | (1 << 12) | (1 << 30));
  const h = (await api('/health')).body;
  assert.ok(h.ok && h.accounts[0].bot.username === 'testbot' && h.accounts[0].token_valid);
  assert.ok(!JSON.stringify(h).includes('SECRET') && !JSON.stringify(h).includes('TK1'), '/health 不含密钥和 token');

  sock.send(JSON.stringify({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { id: 'MSGX', author: { user_openid: 'UOPEN' }, content: '你好', timestamp: new Date().toISOString() } }));
  const it = await until(async () => (await api('/pending?account=q1')).body.items[0]);
  assert.ok(it.id === 'q1:MSGX' && it.platform === 'qq' && it.scope === 'c2c' && it.target === 'UOPEN' && it.content === '你好');
  const ack = await until(() => st.posts[0]);
  assert.equal(ack.url, '/v2/users/UOPEN/messages'); assert.equal(ack.body.msg_id, 'MSGX'); assert.equal(ack.body.content, '收到，正在处理…');
  assert.equal(ack.auth, 'QQBot TK1');
  await api('/reply', { id: it.id, content: '这是回复' });
  const rep = await until(() => st.posts.find(p => p.body.content === '这是回复'));
  assert.equal(rep.body.msg_id, 'MSGX', '5 分钟内走被动回复');
  assert.ok(rep.body.msg_seq > 0 && rep.body.msg_seq !== ack.body.msg_seq, 'msg_seq 递增');
  const sent = (await api('/outbox?status=sent')).body.items;
  assert.ok(sent.every(x => x.mode === 'passive' && x.sent_msg_id));
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(sess.session_id, 'SESS'); assert.equal(fs.statSync(path.join(dir, 'session.json')).mode & 0o777, 0o600);
});
