// 微信（iLink）：本地 mock iLink + CDN，覆盖 message_id 精度、context_token 路由、ret=-2 等待后重发、媒体加解密
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJson, mediaKey, aesEncrypt, aesDecrypt, cipherSize, CLIENT_VERSION } from '../src/platforms/wechat/ilink.js';
import { buildInboxItem } from '../src/platforms/wechat/inbound.js';
import { wechatOnSendError, createWechat } from '../src/platforms/wechat/index.js';
import { normalizeConfig } from '../src/core/config.js';
import { createService } from '../src/core/service.js';
import { serve, tmpdir, readBody, until, sleep } from './helpers.js';

const BIG_ID = '7389123456789012345';
const PNG = fs.readFileSync(path.resolve('test/fixtures/test.png'));

test('message_id 等 64 位整数不丢精度', () => {
  const o = parseJson(`{"msgs":[{"message_id":${BIG_ID},"msg_id": -${BIG_ID},"svr_id":1,"seq":${BIG_ID}}]}`);
  assert.equal(o.msgs[0].message_id, BIG_ID);
  assert.equal(o.msgs[0].msg_id, '-' + BIG_ID);
  assert.equal(o.msgs[0].svr_id, '1');
  assert.equal(typeof o.msgs[0].seq, 'number', '其他字段不动');
  assert.equal(CLIENT_VERSION, (2 << 16) | (4 << 8) | 10);
});

test('媒体密钥三种格式 + AES-128-ECB 往返', () => {
  const key = crypto.randomBytes(16);
  assert.ok(mediaKey({ aeskey: key.toString('hex') }).equals(key));
  assert.ok(mediaKey({ media: { aes_key: key.toString('base64') } }).equals(key));
  assert.ok(mediaKey({ media: { aes_key: Buffer.from(key.toString('hex')).toString('base64') } }).equals(key));
  assert.equal(mediaKey({ media: {} }), null);
  const c = aesEncrypt(PNG, key);
  assert.equal(c.length, cipherSize(PNG.length));
  assert.ok(aesDecrypt(c, key).equals(PNG));
});

test('入站解析：文字/图片/语音转写/文件/视频，忽略自己发的', () => {
  const key = crypto.randomBytes(16).toString('hex');
  const m = { message_id: BIG_ID, from_user_id: 'u@im.wechat', message_type: 1, context_token: 'C', item_list: [
    { type: 1, text_item: { text: '你好' } },
    { type: 2, image_item: { aeskey: key, media: { encrypt_query_param: 'P1' } } },
    { type: 3, voice_item: { text: '语音内容', media: { encrypt_query_param: 'P2', aes_key: Buffer.from(key).toString('base64') } } },
    { type: 4, file_item: { file_name: '报告.pdf', len: '1234', media: { encrypt_query_param: 'P3', aes_key: Buffer.from(key).toString('base64') } } },
    { type: 5, video_item: { media: { encrypt_query_param: 'P4' } } },
  ] };
  const it = buildInboxItem(m);
  assert.equal(it.native_id, BIG_ID); assert.equal(it.scope, 'c2c'); assert.equal(it.target, 'u@im.wechat'); assert.equal(it.content, '你好');
  assert.deepEqual(it.attachments.map(a => a.kind), ['image', 'voice', 'file', 'video']);
  assert.equal(it.attachments[1].transcript, '语音内容');
  assert.ok(it.attachments[2].filename === '报告.pdf' && it.attachments[2].size === 1234);
  assert.equal(it.attachments[3].status, 'failed', '没有密钥的直接标失败');
  assert.equal(it.attachments_ready, false);
  assert.equal(buildInboxItem({ ...m, message_type: 2 }), null);
});

test('发送失败判定', () => {
  assert.equal(wechatOnSendError({}, Object.assign(new Error('x'), { noContext: true })), 'waiting');
  assert.equal(wechatOnSendError({}, Object.assign(new Error('x'), { ret: -2 })), 'waiting');
  assert.equal(wechatOnSendError({}, new Error('文件不存在：/a')), 'failed');
  assert.equal(wechatOnSendError({}, Object.assign(new Error('x'), { ret: -1 })), undefined);
});

// ---------------- 端到端（mock 服务） ----------------
const imgKey = crypto.randomBytes(16);
const st = { updates: [], sends: [], uploads: [], uploadReqs: [], hooks: [], sendRet: 0, headers: [], buf: [] };
const M = await serve(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const body = await readBody(req);
  const json = (o, raw) => { res.setHeader('Content-Type', 'application/json'); res.end(raw || JSON.stringify(o)); };
  if (u.pathname === '/hook') { st.hooks.push({ auth: req.headers.authorization, body: JSON.parse(body) }); return json({ ok: true }); }
  if (u.pathname.startsWith('/ilink/')) st.headers.push(req.headers);
  if (u.pathname === '/ilink/bot/getupdates') {
    const b = JSON.parse(body); st.buf.push(b.get_updates_buf);
    const next = st.updates.shift();
    if (next) return json(null, next);
    await sleep(100); return json({ ret: 0, msgs: [], get_updates_buf: b.get_updates_buf });
  }
  if (u.pathname.startsWith('/ilink/bot/msg/notify')) return json({ ret: 0 });
  if (u.pathname === '/ilink/bot/sendmessage') {
    const b = JSON.parse(body);
    if (st.sendRet) { const r = st.sendRet; st.sendRet = 0; st.sends.push({ ...b, rejected: r }); return json({ ret: r, errmsg: 'context expired' }); }
    st.sends.push(b); return json({ ret: 0 });
  }
  if (u.pathname === '/ilink/bot/getuploadurl') { const b = JSON.parse(body); st.uploadReqs.push(b); return json({ ret: 0, upload_param: 'UP_' + b.filekey }); }
  if (u.pathname === '/c2c/upload') { st.uploads.push({ q: Object.fromEntries(u.searchParams), body }); res.setHeader('x-encrypted-param', 'DLP_' + u.searchParams.get('filekey')); return res.end(); }
  if (u.pathname === '/c2c/download' && u.searchParams.get('encrypted_query_param') === 'IMG1') return res.end(aesEncrypt(PNG, imgKey));
  res.statusCode = 404; res.end();
});
const root = tmpdir('imwb-wx-');
after(async () => { await svc?.stop(); await M.close(); fs.rmSync(root, { recursive: true, force: true }); });
let svc, B;
const api = async (p, b) => { const r = await fetch(B + p, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined); return { status: r.status, body: await r.json() }; };
const upd = (msgs, buf) => `{"ret":0,"get_updates_buf":"${buf}","msgs":[${msgs.join(',')}]}`;
const textMsg = (id, from, ctx, text) => `{"message_id":${id},"from_user_id":"${from}","message_type":1,"context_token":"${ctx}","item_list":[{"type":1,"text_item":{"text":"${text}"}}]}`;

test('端到端：收消息（精度 + 图片解密 + webhook）→ 按 id 回复走 context_token', async () => {
  const cfg = normalizeConfig({ port: 0, accounts: [{ id: 'wx1', platform: 'wechat', base_url: M.base, cdn_base: M.base + '/c2c', poll_timeout_ms: 300 }] }, root);
  fs.mkdirSync(path.join(root, 'data', 'wx1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'wx1', 'credentials.json'), JSON.stringify({ token: 'tok-test', accountId: 'bot@im.bot', baseUrl: M.base }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'data', 'webhook_url'), M.base + '/hook', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'data', 'webhook_key'), 'hook-key', { mode: 0o600 });
  svc = createService(cfg, { factories: { wechat: createWechat }, fatal: m => { throw new Error(m); }, log: () => {} });
  for (const a of svc.accounts.values()) a.webhook_opts = {};
  svc.start(); const server = await svc.listen(0, '127.0.0.1'); B = `http://127.0.0.1:${server.address().port}`;

  st.updates.push(upd([
    `{"message_id":${BIG_ID},"from_user_id":"alice@im.wechat","message_type":1,"context_token":"CTX1","item_list":[{"type":1,"text_item":{"text":"看图"}},{"type":2,"image_item":{"media":{"encrypt_query_param":"IMG1","aes_key":"${Buffer.from(imgKey.toString('hex')).toString('base64')}"}}}]}`,
    `{"message_id":1,"from_user_id":"bot@im.bot","message_type":2,"item_list":[{"type":1,"text_item":{"text":"自己发的"}}]}`,
  ], 'BUF1'));
  const pend = await until(async () => { const r = await api('/pending'); const it = r.body.items[0]; return it?.attachments_ready ? r.body : null; }, 5000);
  assert.equal(pend.count, 1, '自己发的消息被忽略');
  const it = pend.items[0];
  assert.equal(it.id, `wx1:${BIG_ID}`); assert.equal(it.native_id, BIG_ID);
  assert.equal(it.platform, 'wechat'); assert.equal(it.account, 'wx1');
  assert.equal(it.attachments[0].status, 'downloaded');
  assert.ok(fs.readFileSync(it.attachments[0].local_path).equals(PNG), '图片解密后和原图一致');
  assert.ok(!('cdn' in it.attachments[0]), 'HTTP 输出不含 CDN 密钥');
  assert.equal(fs.statSync(path.join(root, 'data', 'wx1', 'contexts.json')).mode & 0o777, 0o600);
  await until(() => fs.existsSync(path.join(root, 'data', 'wx1', 'sync_buf')) && st.buf.includes('BUF1'));
  assert.equal(fs.readFileSync(path.join(root, 'data', 'wx1', 'sync_buf'), 'utf8'), 'BUF1');
  assert.equal(fs.statSync(path.join(root, 'data', 'wx1', 'sync_buf')).mode & 0o777, 0o600);

  const hook = await until(() => st.hooks[0], 8000);
  assert.equal(hook.auth, 'Bearer hook-key');
  assert.ok(hook.body.platform === 'wechat' && hook.body.account === 'wx1' && hook.body.messages[0].id === `wx1:${BIG_ID}`);

  const h = st.headers.at(-1);
  assert.equal(h.authorization, 'Bearer tok-test'); assert.equal(h.authorizationtype, 'ilink_bot_token');
  assert.match(Buffer.from(h['x-wechat-uin'], 'base64').toString(), /^\d+$/);
  assert.equal(h['ilink-app-id'], 'bot');

  const r = await api('/reply', { id: it.id, content: '收到' });
  assert.equal(r.status, 200); assert.equal(r.body.account, 'wx1');
  const s = await until(() => st.sends[0]);
  assert.equal(s.msg.to_user_id, 'alice@im.wechat'); assert.equal(s.msg.context_token, 'CTX1');
  assert.deepEqual(s.msg.item_list, [{ type: 1, text_item: { text: '收到' } }]);
  assert.ok(s.msg.message_type === 2 && s.msg.message_state === 2 && /^openclaw-weixin-\d+-[0-9a-f]+$/.test(s.msg.client_id));
  assert.equal(s.base_info.channel_version, '2.4.10');
  assert.equal((await api('/pending')).body.count, 0, '回复后自动标记 done');
});

test('ret=-2 → waiting_context；对方再发消息（新 context_token）后自动重发', async () => {
  st.sends.length = 0; st.sendRet = -2;
  await api('/reply', { account: 'wx1', target: 'alice@im.wechat', content: '晚点的提醒' });
  const w = await until(async () => (await api('/outbox?status=waiting_context')).body.items[0]);
  assert.equal(w.content, '晚点的提醒');
  assert.equal(st.sends[0].rejected, -2);
  st.updates.push(upd([textMsg('42', 'alice@im.wechat', 'CTX2', '在吗')], 'BUF2'));
  const s = await until(() => st.sends.find(x => !x.rejected));
  assert.equal(s.msg.context_token, 'CTX2'); assert.equal(s.msg.item_list[0].text_item.text, '晚点的提醒');
  await until(async () => (await api('/outbox?status=sent')).body.items.some(x => x.content === '晚点的提醒'));
  const h = (await api('/health')).body.accounts[0];
  assert.ok(h.ok && h.state === 'running' && h.session === 'ok' && h.contacts_with_context === 1);
});

test('没有上下文的联系人：进 waiting_context，/outbox/retry 可放回', async () => {
  await api('/reply', { account: 'wx1', target: 'bob@im.wechat', content: '主动消息' });
  const w = await until(async () => (await api('/outbox?status=waiting_context')).body.items.find(x => x.target === 'bob@im.wechat'));
  assert.match(w.last_error, /context_token/);
  const r = await api('/outbox/retry', { id: w.id });
  assert.equal(r.body.requeued, 1);
});

test('发图片：AES 加密上传 CDN → image_item', async () => {
  st.sends.length = 0;
  const r = await api('/reply', { account: 'wx1', target: 'alice@im.wechat', files: [{ path: path.resolve('test/fixtures/test.png') }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await until(() => st.sends.find(x => x.msg.item_list[0].type === 2));
  const up = st.uploadReqs.at(-1), cdn = st.uploads.at(-1);
  assert.ok(up.media_type === 1 && up.rawsize === PNG.length && up.filesize === cipherSize(PNG.length) && up.no_need_thumb === true);
  assert.equal(up.rawfilemd5, crypto.createHash('md5').update(PNG).digest('hex'));
  assert.equal(cdn.q.encrypted_query_param, 'UP_' + up.filekey);
  assert.ok(aesDecrypt(cdn.body, Buffer.from(up.aeskey, 'hex')).equals(PNG), 'CDN 收到的密文能用 aeskey 解开');
  const media = s.msg.item_list[0].image_item.media;
  assert.equal(media.encrypt_query_param, 'DLP_' + up.filekey);
  assert.equal(Buffer.from(media.aes_key, 'base64').toString(), up.aeskey, 'aes_key = base64(hex 密钥)');
  assert.equal(media.encrypt_type, 1);
  assert.equal(s.msg.context_token, 'CTX2');
});

test('拒绝发送账号目录里的凭证；wechat 不支持 group scope', async () => {
  const r = await api('/reply', { account: 'wx1', target: 'alice@im.wechat', files: [{ path: path.join(root, 'data', 'wx1', 'credentials.json') }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /不允许/);
  const r2 = await api('/reply', { account: 'wx1', scope: 'group', target: 'g', content: 'x' });
  assert.equal(r2.status, 400);
});
