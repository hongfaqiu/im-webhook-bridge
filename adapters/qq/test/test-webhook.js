'use strict';
// webhook 推送单元测试：本地 http 模拟下游 webhook，不连外网
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create } = require('../webhook');

(async () => {
  const got = []; let failNext = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (failNext > 0) { failNext--; res.statusCode = 503; return res.end('busy'); }
      got.push({ headers: req.headers, body: JSON.parse(b) }); res.end('{"ok":true}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const URL_ = `http://127.0.0.1:${srv.address().port}/hooks/secretpath123`;
  const KEY = 'sk-test-KEY-should-never-appear';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqwh-'));
  const logs = []; const log = (...a) => logs.push(a.join(' '));
  let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const msg = (n, extra) => ({ id: 'M' + n, scope: 'c2c', target: 'U1', author: 'U1', content: '第' + n + '条', attachments: [], received_at: new Date().toISOString(), ...extra });

  // 1. 未配置：不推、不抛
  let h = create({ dataDir: dir, log, debounceMs: 100, maxWaitMs: 1000, retryDelays: [50, 50] });
  h.push(msg(0)); await sleep(200); await h._idle();
  ok(got.length === 0 && logs.some(l => /未配置/.test(l)), '未配置 webhook 时不推送，只写日志');

  // 2. 配置后（权限过宽会被改成 600）；3 条连发合并成一次
  fs.writeFileSync(path.join(dir, 'webhook_url'), URL_ + '\n', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'webhook_key'), KEY + '\n', { mode: 0o644 });
  h.push(msg(1)); await sleep(40); h.push(msg(2, { attachments: [{ kind: 'image', filename: 'a.png', local_path: '/x/a.png' }] })); await sleep(40); h.push(msg(3)); h.push(msg(3));
  await sleep(250); await h._idle();
  ok(got.length === 1, '防抖：3 条连发合并成 1 次 POST');
  const b = got[0].body;
  ok(b.batch === true && b.count === 3 && b.messages.map(m => m.id).join() === 'M1,M2,M3', 'payload 含 batch/count/messages，重复 id 去重');
  ok(JSON.stringify(Object.keys(b.messages[1]).sort()) === JSON.stringify(['attachments', 'author', 'content', 'id', 'received_at', 'scope', 'target']), '每条只含精简字段');
  ok(b.messages[1].attachments[0] === 'a.png', '附件只给文件名');
  ok(got[0].headers.authorization === 'Bearer ' + KEY, '带 Authorization: Bearer <key>');
  ok((fs.statSync(path.join(dir, 'webhook_key')).mode & 0o777) === 0o600 && (fs.statSync(path.join(dir, 'webhook_url')).mode & 0o777) === 0o600, '配置文件权限被收紧为 600');

  // 3. maxWait：持续来消息也会在上限时间内推出
  got.length = 0; h = create({ dataDir: dir, log, debounceMs: 150, maxWaitMs: 300, retryDelays: [50] });
  for (let i = 0; i < 8; i++) { h.push(msg(10 + i)); await sleep(60); }
  await sleep(200); await h._idle();
  ok(got.length >= 2 && got.reduce((n, g) => n + g.body.count, 0) === 8, `持续连发时按 maxWait 分批推出（${got.length} 批，共 8 条）`);

  // 4. 5xx 重试后成功
  got.length = 0; failNext = 2; h = create({ dataDir: dir, log, debounceMs: 20, retryDelays: [50, 50, 50] });
  h.push(msg(20)); await sleep(60); await h._idle();
  ok(got.length === 1 && h.status().pushed === 1, '503 两次后第 3 次成功');

  // 5. 一直失败：放弃并写 webhook-failed.jsonl，不抛异常
  got.length = 0; failNext = 99; h = create({ dataDir: dir, log, debounceMs: 20, retryDelays: [30, 30] });
  h.push(msg(30)); await sleep(60); await h._idle();
  const failed = fs.readFileSync(path.join(dir, 'webhook-failed.jsonl'), 'utf8');
  ok(got.length === 0 && /M30/.test(failed) && h.status().failed === 1, '重试用完写 webhook-failed.jsonl');
  failNext = 0;

  // 6. 连不上：不抛
  fs.writeFileSync(path.join(dir, 'webhook_url'), 'http://127.0.0.1:1/x', { mode: 0o600 });
  h = create({ dataDir: dir, log, debounceMs: 20, retryDelays: [20] });
  h.push(msg(40)); await sleep(50); await h._idle();
  ok(h.status().failed === 1, '网络错误也只记日志');

  // 7. 日志里没有 key 和完整 URL
  const all = logs.join('\n') + failed;
  ok(!all.includes(KEY) && !all.includes('secretpath123'), '日志/失败记录里没有 key 和完整 URL');

  srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(`webhook 测试通过 ${pass} 项`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
