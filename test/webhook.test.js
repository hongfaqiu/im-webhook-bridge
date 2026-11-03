// webhook 推送：本地 http 模拟下游，不连外网
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWebhook } from '../src/core/webhook.js';
import { serve, tmpdir, sleep } from './helpers.js';

const got = []; let failNext = 0;
const S = await serve((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (failNext > 0) { failNext--; res.statusCode = 503; return res.end('busy'); }
    got.push({ headers: req.headers, body: JSON.parse(b) }); res.end('{"ok":true}');
  });
});
const URL_ = `${S.base}/hooks/secretpath123`;
const KEY = 'sk-test-KEY-should-never-appear';
const dir = tmpdir('imwb-wh-'), accDir = path.join(dir, 'acc1'); fs.mkdirSync(accDir);
const logs = []; const log = (...a) => logs.push(a.join(' '));
const meta = { platform: 'qq', account: 'acc1' };
const mk = o => createWebhook({ dirs: [accDir, dir], failDir: accDir, log, meta, ...o });
const msg = (n, extra) => ({ id: 'acc1:M' + n, platform: 'qq', account: 'acc1', native_id: 'M' + n, scope: 'c2c', target: 'U1', author: 'U1', content: '第' + n + '条', attachments: [], received_at: new Date().toISOString(), ...extra });
after(async () => { await S.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('未配置时不推送，只写日志', async () => {
  const h = mk({ debounceMs: 50, retryDelays: [50] });
  h.push(msg(0)); await sleep(120); await h._idle();
  assert.equal(got.length, 0); assert.ok(logs.some(l => /未配置/.test(l)));
  assert.equal(h.status().configured, false);
});

test('全局配置：权限收紧 600，防抖合并，精简字段', async () => {
  fs.writeFileSync(path.join(dir, 'webhook_url'), URL_ + '\n', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'webhook_key'), KEY + '\n', { mode: 0o644 });
  const h = mk({ debounceMs: 100, maxWaitMs: 1000, retryDelays: [50] });
  h.push(msg(1)); await sleep(30);
  h.push(msg(2, { attachments: [{ kind: 'image', filename: 'a.png', local_path: '/x/a.png', cdn: { key: 'secret' } }] })); await sleep(30);
  h.push(msg(3)); h.push(msg(3));
  await sleep(250); await h._idle();
  assert.equal(got.length, 1);
  const b = got[0].body;
  assert.equal(b.source, 'im-webhook-bridge'); assert.equal(b.platform, 'qq'); assert.equal(b.account, 'acc1');
  assert.ok(b.batch === true && b.count === 3 && b.messages.map(m => m.id).join() === 'acc1:M1,acc1:M2,acc1:M3');
  assert.deepEqual(Object.keys(b.messages[1]).sort(), ['account', 'attachments', 'author', 'content', 'id', 'platform', 'received_at', 'scope', 'target']);
  assert.equal(b.messages[1].attachments[0], 'a.png');
  assert.ok(!JSON.stringify(b).includes('secret'), '内部字段不外泄');
  assert.equal(got[0].headers.authorization, 'Bearer ' + KEY);
  assert.equal(got[0].headers['x-inbound-id'], 'acc1:M1,acc1:M2,acc1:M3');
  for (const f of ['webhook_url', 'webhook_key']) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  assert.equal(h.status().source, 'global');
});

test('账号目录的 webhook 优先于全局', async () => {
  got.length = 0;
  fs.writeFileSync(path.join(accDir, 'webhook_url'), URL_ + '?acc=1', { mode: 0o600 });
  fs.writeFileSync(path.join(accDir, 'webhook_key'), 'acc-key', { mode: 0o600 });
  const h = mk({ debounceMs: 20, retryDelays: [20] });
  h.push(msg(5)); await sleep(80); await h._idle();
  assert.equal(got[0].headers.authorization, 'Bearer acc-key'); assert.equal(h.status().source, 'account');
  fs.unlinkSync(path.join(accDir, 'webhook_url')); fs.unlinkSync(path.join(accDir, 'webhook_key'));
});

test('maxWait：持续来消息也会分批推出', async () => {
  got.length = 0; const h = mk({ debounceMs: 150, maxWaitMs: 300, retryDelays: [50] });
  for (let i = 0; i < 8; i++) { h.push(msg(10 + i)); await sleep(60); }
  await sleep(200); await h._idle();
  assert.ok(got.length >= 2); assert.equal(got.reduce((n, g) => n + g.body.count, 0), 8);
});

test('5xx 重试成功；一直失败写 webhook-failed.jsonl；网络错误不抛', async () => {
  got.length = 0; failNext = 2; let h = mk({ debounceMs: 20, retryDelays: [30, 30, 30] });
  h.push(msg(20)); await sleep(50); await h._idle();
  assert.ok(got.length === 1 && h.status().pushed === 1);
  got.length = 0; failNext = 99; h = mk({ debounceMs: 20, retryDelays: [20, 20] });
  h.push(msg(30)); await sleep(50); await h._idle();
  const failed = fs.readFileSync(path.join(accDir, 'webhook-failed.jsonl'), 'utf8');
  assert.ok(got.length === 0 && /acc1:M30/.test(failed) && h.status().failed === 1);
  failNext = 0;
  fs.writeFileSync(path.join(dir, 'webhook_url'), 'http://127.0.0.1:1/x', { mode: 0o600 });
  h = mk({ debounceMs: 20, retryDelays: [20] });
  h.push(msg(40)); await sleep(50); await h._idle();
  assert.equal(h.status().failed, 1);
  const all = logs.join('\n') + failed;
  assert.ok(!all.includes(KEY) && !all.includes('secretpath123'), '日志里没有 key 和完整 URL');
});
