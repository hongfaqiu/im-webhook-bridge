// 核心层：多账号路由、账号锁、未绑定自动上线、自动回执、配置校验（mock 平台，不连任何真实服务）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeConfig } from '../src/core/config.js';
import { createService } from '../src/core/service.js';
import { acquireLock } from '../src/core/lock.js';
import { splitText } from '../src/core/outbox.js';
import { redact } from '../src/util.js';
import { tmpdir, until } from './helpers.js';

const root = tmpdir('imwb-core-');
const sent = [];
function mockFactory(name) {
  return ctx => {
    let running = false;
    const p = {
      name, scopes: ['c2c', 'group'], textLimit: 10, autoAck: ctx.options.auto_ack || null, sendLimits: undefined,
      hasCredentials: () => fs.existsSync(path.join(ctx.dir, 'credentials.json')),
      start() { running = true; }, stop() { running = false; },
      health: () => ({ ok: running }),
      async send(it) { if (it.content === 'boom') throw new Error('boom'); sent.push({ account: ctx.account, ...it }); return { sent_msg_id: 'S' + sent.length }; },
      onSendError: () => 'failed', attachmentSources: () => [], validateReply: () => null,
      inject: (id, extra = {}) => ctx.onMessage({ native_id: id, scope: 'c2c', target: 'U-' + ctx.account, author: 'U', content: 'hi ' + id, attachments: [], attachments_ready: true, msg_ts: Date.now(), received_at: new Date().toISOString(), status: 'pending', ...extra }),
    };
    return p;
  };
}
const factories = { qq: mockFactory('qq'), wechat: mockFactory('wechat') };
const cfg = normalizeConfig({ port: 0, accounts: [{ id: 'a1', platform: 'qq', auto_ack: '收到' }, { id: 'a2', platform: 'wechat' }, { id: 'off', platform: 'qq', enabled: false }] }, root);
let svc, B;
const api = async (p, b) => { const r = await fetch(B + p, b ? { method: 'POST', body: JSON.stringify(b) } : undefined); return { status: r.status, body: await r.json() }; };
after(async () => { await svc?.stop(); fs.rmSync(root, { recursive: true, force: true }); });

test('配置校验', () => {
  assert.throws(() => normalizeConfig({ accounts: [{ id: 'a b', platform: 'qq' }] }, root), /只能用字母/);
  assert.throws(() => normalizeConfig({ accounts: [{ id: 'a', platform: 'qq' }, { id: 'a', platform: 'qq' }] }, root), /重复/);
  assert.throws(() => normalizeConfig({ accounts: [{ id: 'a', platform: 'line' }] }, root), /platform/);
  const c = normalizeConfig({ data_dir: 'd', accounts: [{ id: 'x', platform: 'qq' }, { id: 'y', platform: 'qq', dir: '/tmp/elsewhere' }] }, root);
  assert.equal(c.accounts[0].dir, path.join(root, 'd', 'x')); assert.equal(c.accounts[1].dir, '/tmp/elsewhere');
  assert.equal(c.host, '127.0.0.1');
});

test('多账号启动：a1 已绑定、a2 未绑定、off 停用', async () => {
  fs.mkdirSync(path.join(root, 'data', 'a1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'a1', 'credentials.json'), '{}');
  svc = createService(cfg, { factories, fatal: () => {}, log: () => {} });
  svc.start(); const s = await svc.listen(0, '127.0.0.1'); B = `http://127.0.0.1:${s.address().port}`;
  const h = (await api('/health')).body;
  assert.deepEqual(h.accounts.map(a => [a.id, a.platform, a.state]), [['a1', 'qq', 'running'], ['a2', 'wechat', 'unbound'], ['off', 'qq', 'disabled']]);
  assert.equal(h.ok, false, '有未绑定账号时整体不 ok');
  assert.equal((fs.statSync(path.join(root, 'data', 'a1')).mode & 0o777), 0o700);
});

test('账号锁：同一账号不能被第二个进程/服务实例占用', () => {
  const svc2 = createService(cfg, { factories, fatal: () => {}, log: () => {} });
  assert.throws(() => svc2.start(), e => e.code === 'LOCKED');
  const d = tmpdir('imwb-lock-');
  const l = acquireLock(d); assert.throws(() => acquireLock(d), e => e.code === 'LOCKED');
  l.release(); acquireLock(d).release();
  fs.writeFileSync(path.join(d, 'account.lock'), JSON.stringify({ pid: 999999999 }));
  acquireLock(d).release(); // 过期锁被回收
  fs.rmSync(d, { recursive: true });
});

test('收消息：全局 id、去重、自动回执、/pending 按账号过滤', async () => {
  const a1 = svc.accounts.get('a1');
  assert.ok(a1.platform.inject('m1'));
  assert.equal(a1.platform.inject('m1'), null, '重复消息去重');
  const p = (await api('/pending')).body;
  assert.equal(p.count, 1); assert.equal(p.items[0].id, 'a1:m1'); assert.equal(p.items[0].platform, 'qq'); assert.equal(p.items[0].account, 'a1');
  assert.equal((await api('/pending?account=a2')).body.count, 0);
  assert.equal((await api('/pending?account=nope')).status, 404);
  const ack = await until(() => sent.find(x => x.content === '收到'));
  assert.ok(ack.account === 'a1' && ack.reply_to === 'm1', '自动回执带 reply_to');
});

test('/reply 按 id 路由到对应账号；长文本分段；未运行账号拒绝', async () => {
  sent.length = 0;
  const r = await api('/reply', { id: 'a1:m1', content: '0123456789abcdefghij!' });
  assert.equal(r.status, 200); assert.equal(r.body.queued.length, 3);
  assert.ok(r.body.queued.every(q => q.id.startsWith('a1:')));
  await until(() => sent.length === 3);
  assert.deepEqual(sent.map(s => s.content), ['0123456789', 'abcdefghij', '!']);
  assert.ok(sent.every(s => s.account === 'a1' && s.target === 'U-a1' && s.platform === 'qq'));
  assert.equal((await api('/pending')).body.count, 0, 'done 了');
  assert.equal((await api('/reply', { account: 'a2', target: 'x', content: 'y' })).status, 409, '未绑定账号不能发');
  assert.equal((await api('/reply', { id: 'zz:1', content: 'y' })).status, 404);
  assert.equal((await api('/reply', { id: 'a1:m1' })).status, 400, '空回复');
  assert.equal((await api('/reply', { account: 'a1', scope: 'channel', target: 'x', content: 'y' })).status, 400, '平台不支持的 scope');
});

test('失败、重试、/ack、/inbox', async () => {
  await api('/reply', { account: 'a1', target: 'T', content: 'boom' });
  const f = await until(async () => (await api('/outbox?status=failed&account=a1')).body.items[0]);
  assert.equal(f.last_error, 'boom');
  assert.equal((await api('/outbox/retry', { id: f.id })).body.requeued, 1);
  svc.accounts.get('a1').platform.inject('m2');
  assert.equal((await api('/ack', { id: 'a1:m2' })).status, 200);
  assert.equal((await api('/inbox?status=done&account=a1')).body.count, 2);
  assert.equal((await api('/nope')).status, 404);
});

test('未绑定账号拿到凭证后自动上线', { timeout: 15000 }, async () => {
  fs.writeFileSync(path.join(root, 'data', 'a2', 'credentials.json'), '{}');
  await until(async () => (await api('/health?account=a2')).body.accounts[0].state === 'running', 12000);
  svc.accounts.get('a2').platform.inject('w1');
  const p = (await api('/pending?platform=wechat')).body;
  assert.equal(p.items[0].id, 'a2:w1');
});

test('工具函数：分段与脱敏', () => {
  assert.deepEqual(splitText('abcdef', 4), ['abcd', 'ef']);
  const s = redact('Authorization: Bearer abc.def QQBot xyz {"appSecret":"s3cr3t","token":"t0k"}');
  assert.ok(!/abc\.def|xyz|s3cr3t|t0k/.test(s), s);
});
