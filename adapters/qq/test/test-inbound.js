'use strict';
// 收附件 / 事件解析单元测试：本地 http 服务模拟 QQ 附件 URL，写到临时目录，不碰真实收件箱
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.QQBOT_REF_FILE = path.join(os.tmpdir(), 'qqbot-test-ref-' + process.pid + '.jsonl');
const ib = require('../inbound');
const media = require('../media');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const big = Buffer.alloc(300 * 1024, 7);
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/img')) { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
  if (req.url.startsWith('/wav')) { res.setHeader('Content-Type', 'audio/wav'); return res.end(Buffer.from('RIFF....WAVEfmt ')); }
  if (req.url.startsWith('/doc')) { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(Buffer.from('%PDF-1.4 test')); }
  if (req.url.startsWith('/big')) { res.setHeader('Content-Length', big.length); return res.end(big); }
  if (req.url.startsWith('/chunked')) { res.write(big.subarray(0, 150000)); return setTimeout(() => res.end(big.subarray(150000)), 50); }
  if (req.url.startsWith('/slow')) { res.write('x'); return; }
  res.statusCode = 404; res.end();
});

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${srv.address().port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqib-'));
  const opts = { root, dlOpts: { allowPrivate: true } };
  let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

  // 1. C2C 事件：图片 + 文件 + 语音（有 voice_wav_url 和 asr_refer_text）+ 表情 + 引用
  const ev = { id: 'MSG_TEST_1', author: { user_openid: 'U_TEST' }, timestamp: new Date().toISOString(),
    content: '看看这个 <faceType=1,faceId="13",ext="' + Buffer.from(JSON.stringify({ text: '[呲牙]' })).toString('base64') + '"> [<face,id=16>]',
    message_scene: { ext: ['msg_idx=REFIDX_SELF', 'ref_msg_idx=REFIDX_OLD'] },
    attachments: [
      { content_type: 'image/png', url: B + '/img', filename: 'a.png', size: PNG.length },
      { content_type: 'file', url: B + '/doc', filename: '课件 v26.pdf', size: 13 },
      { content_type: 'voice', url: B + '/404', voice_wav_url: B + '/wav', filename: 'v.amr', asr_refer_text: '你好小马' },
    ] };
  ib.refSet('REFIDX_OLD', { content: '之前那条', isBot: true, messageId: 'M0' });
  const item = ib.buildInboxItem('C2C_MESSAGE_CREATE', ev, { botIds: [] });
  ok(item.scope === 'c2c' && item.target === 'U_TEST' && item.status === 'pending', 'c2c 条目 scope/target/status');
  ok(item.content.includes('【表情: [呲牙]】') && item.content.includes('👍'), '表情解析: ' + item.content);
  ok(item.quote && item.quote.text === '之前那条' && item.quote.from_bot, '引用 ref_msg_idx 回查');
  ok(item.msg_idx === 'REFIDX_SELF' && item.attachments_ready === false, 'msg_idx 与 attachments_ready=false');
  ok(item.attachments.map(a => a.kind).join() === 'image,file,voice', '附件类型 image,file,voice');
  await ib.downloadAll(item.attachments, item.id, opts);
  const [img, doc, voice] = item.attachments;
  ok(img.status === 'downloaded' && fs.readFileSync(img.local_path).equals(PNG), '图片下载内容一致');
  ok(doc.status === 'downloaded' && path.basename(doc.local_path).endsWith('_课件 v26.pdf') && doc.filename === '课件 v26.pdf', '文件保留原名: ' + path.basename(doc.local_path));
  ok(voice.status === 'downloaded' && voice.local_format === 'wav' && voice.local_path.endsWith('.wav') && voice.transcript === '你好小马', '语音优先 wav + QQ 转写');
  const day = path.basename(path.dirname(img.local_path));
  ok(/^\d{4}-\d{2}-\d{2}$/.test(day), '按北京日期分目录 ' + day);
  ok((fs.statSync(path.dirname(img.local_path)).mode & 0o777) === 0o700 && (fs.statSync(root).mode & 0o777) === 0o700, '目录权限 700');
  ok(item.attachments.every(a => (fs.statSync(a.local_path).mode & 0o777) === 0o600), '文件权限 600');

  // 2. 上限：声明 size 超限 / Content-Length 超限 / 无长度流式超限 / 超时
  const r1 = ib.normalizeAttachments([{ content_type: 'file', url: B + '/big', filename: 'x.zip', size: 2 * 1024 ** 3 }])[0];
  await ib.downloadOne(r1, 'm2', opts); ok(r1.status === 'too_large' && !r1.local_path, '声明 2GB → too_large 不下载');
  const r2 = ib.normalizeAttachments([{ content_type: 'file', url: B + '/big', filename: 'b.bin' }])[0];
  await ib.downloadOne(r2, 'm3', { ...opts, max: 100 * 1024 }); ok(r2.status === 'too_large', 'Content-Length 超限拒绝');
  const r3 = ib.normalizeAttachments([{ content_type: 'file', url: B + '/chunked', filename: 'c.bin' }])[0];
  await ib.downloadOne(r3, 'm4', { ...opts, max: 100 * 1024 }); ok(r3.status === 'too_large' && fs.readdirSync(path.join(root, day)).every(f => !f.includes('c.bin')), '流式超限中断并删除半截文件');
  const r4 = ib.normalizeAttachments([{ content_type: 'file', url: B + '/slow', filename: 's.bin' }])[0];
  await ib.downloadOne(r4, 'm5', { ...opts, timeout: 500 }); ok(r4.status === 'failed' && /超时/.test(r4.error), '下载超时 → failed: ' + r4.error);
  // 3. SSRF：默认不允许内网 URL
  const r5 = ib.normalizeAttachments([{ content_type: 'image/png', url: B + '/img' }])[0];
  await ib.downloadOne(r5, 'm6', { root }); ok(r5.status === 'failed' && /内网/.test(r5.error), '默认拦截内网 URL');

  // 4. 群消息 @ 处理
  const g = ib.buildInboxItem('GROUP_AT_MESSAGE_CREATE', { id: 'G1', group_openid: 'GRP', author: { member_openid: 'M1' }, content: '<@BOTX> 你好 <@M2>', mentions: [{ member_openid: 'BOTX', is_you: true }, { member_openid: 'M2', nickname: '小明' }] }, {});
  ok(g.scope === 'group' && g.target === 'GRP' && g.content === '你好 @小明' && g.status === 'pending', '群 @：去掉机器人 @、替换他人昵称: ' + g.content);
  const g2 = ib.buildInboxItem('GROUP_MESSAGE_CREATE', { id: 'G2', group_openid: 'GRP', author: { member_openid: 'M1' }, content: '随便聊' }, {});
  ok(g2.status === 'observed' && g2.mentioned === false, '群非 @ 消息只记录不进 pending');
  ok(ib.buildInboxItem('GROUP_MESSAGE_CREATE', { id: 'G3', group_openid: 'GRP', author: { member_openid: 'B', bot: true }, content: 'x' }, {}) === null, '忽略其他机器人');
  // 5. 频道 @ / 频道私信
  const ch = ib.buildInboxItem('AT_MESSAGE_CREATE', { id: 'C1', channel_id: 'CH', guild_id: 'GU', author: { id: 'A', username: 'u' }, content: '<@!999> hi' }, { botIds: ['999'] });
  ok(ch.scope === 'channel' && ch.target === 'CH' && ch.content === 'hi', '频道 @ 消息');
  const dm = ib.buildInboxItem('DIRECT_MESSAGE_CREATE', { id: 'D1', guild_id: 'GU2', channel_id: 'C', author: { id: 'A' }, content: 'dm' }, {});
  ok(dm.scope === 'dm' && dm.target === 'GU2', '频道私信 target=guild_id');
  // 6. 引用 msg_type 103 msg_elements
  const q = ib.buildInboxItem('C2C_MESSAGE_CREATE', { id: 'Q1', author: { user_openid: 'U' }, content: '这个', message_type: 103, msg_elements: [{ msg_idx: 'REFIDX_Z', content: '原文', attachments: [{ content_type: 'image/png', filename: 'p.png' }] }] }, {});
  ok(q.quote.ref === 'REFIDX_Z' && q.quote.source === 'msg_elements' && q.quote.text === '原文 [图片:p.png]', '103 引用元素: ' + q.quote.text);

  // 7. 发送侧校验（不发）
  const tmpf = path.join(root, 'ok.txt'); fs.writeFileSync(tmpf, 'hello');
  const s1 = await media.resolveFileSpec({ path: tmpf }); ok(s1.type === 'file' && s1.size === 5, '本地 txt → file');
  const s2 = await media.resolveFileSpec({ path: img.local_path, type: 'image' }); ok(s2.type === 'image', '收件附件可转发');
  await assert.rejects(media.resolveFileSpec({ path: path.join(__dirname, '..', 'data', 'credentials.json') }), /不允许/); ok(true, '拒绝发送 credentials.json');
  await assert.rejects(media.resolveFileSpec({ path: '/nope/x.pdf' }), /不存在/); ok(true, '不存在文件报错');
  const bigf = path.join(root, 'huge.bin'); fs.writeFileSync(bigf, ''); fs.truncateSync(bigf, 101 * 1024 * 1024);
  await assert.rejects(media.resolveFileSpec({ path: bigf }), /超过 100\.0MB 上限/); ok(true, '101MB → 明确超限错误');
  const pngBig = path.join(root, 'big.png'); fs.writeFileSync(pngBig, ''); fs.truncateSync(pngBig, 31 * 1024 * 1024);
  const s3 = await media.resolveFileSpec({ path: pngBig }); ok(s3.type === 'file' && s3.notes.length, '31MB 图片自动改按文件');
  await assert.rejects(media.resolveFileSpec({ url: B + '/img' }), /内网/); ok(true, 'URL 内网拦截');
  await assert.rejects(media.resolveFileSpec({ path: tmpf, url: 'https://x' }), /只能/); ok(true, 'path/url 二选一');
  ok(media.inferType('a.MP4') === 'video' && media.inferType('a.silk') === 'voice' && media.inferType('a.pptx') === 'file' && media.inferType('a.jpeg') === 'image', '类型推断');

  srv.close(); fs.rmSync(root, { recursive: true, force: true });
  console.log(`全部通过：${pass} 项`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
