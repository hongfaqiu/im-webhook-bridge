// QQ 收件解析 + 附件下载 + 发送侧文件校验：本地 http 模拟附件 URL，写临时目录
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createInbound, normalizeAttachments, attachmentSources } from '../src/platforms/qq/inbound.js';
import { saveAttachment } from '../src/core/attachments.js';
import { resolveFileSpec, inferType, makeForbidden } from '../src/core/media.js';
import { qqOnSendError } from '../src/platforms/qq/index.js';
import { serve, tmpdir } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const big = Buffer.alloc(300 * 1024, 7);
const S = await serve((req, res) => {
  if (req.url.startsWith('/img')) { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
  if (req.url.startsWith('/wav')) { res.setHeader('Content-Type', 'audio/wav'); return res.end(Buffer.from('RIFF....WAVEfmt ')); }
  if (req.url.startsWith('/doc')) return res.end(Buffer.from('%PDF-1.4 test'));
  if (req.url.startsWith('/big')) { res.setHeader('Content-Length', big.length); return res.end(big); }
  if (req.url.startsWith('/chunked')) { res.write(big.subarray(0, 150000)); return setTimeout(() => res.end(big.subarray(150000)), 50); }
  if (req.url.startsWith('/slow')) { res.write('x'); return; }
  res.statusCode = 404; res.end();
});
const B = S.base;
const dir = tmpdir('imwb-qq-');
const root = path.join(dir, 'inbox-files');
const ib = createInbound(dir);
after(async () => { await S.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const dl = (rec, key, o = {}) => saveAttachment(rec, key, { root, sources: attachmentSources(rec, { allowPrivate: o.allowPrivate ?? true }), ...o });

let img;
test('c2c：图片 + 文件 + 语音（wav 优先 + 转写）+ 表情 + 引用', async () => {
  ib.refSet('REFIDX_OLD', { content: '之前那条', isBot: true, messageId: 'M0' });
  const ev = { id: 'MSG_TEST_1', author: { user_openid: 'U_TEST' }, timestamp: new Date().toISOString(),
    content: '看看这个 <faceType=1,faceId="13",ext="' + Buffer.from(JSON.stringify({ text: '[呲牙]' })).toString('base64') + '"> [<face,id=16>]',
    message_scene: { ext: ['msg_idx=REFIDX_SELF', 'ref_msg_idx=REFIDX_OLD'] },
    attachments: [
      { content_type: 'image/png', url: B + '/img', filename: 'a.png', size: PNG.length },
      { content_type: 'file', url: B + '/doc', filename: '课件 v26.pdf', size: 13 },
      { content_type: 'voice', url: B + '/404', voice_wav_url: B + '/wav', filename: 'v.amr', asr_refer_text: '测试语音转写' },
    ] };
  const item = ib.buildInboxItem('C2C_MESSAGE_CREATE', ev, { botIds: [] });
  assert.equal(item.native_id, 'MSG_TEST_1');
  assert.equal(item.scope, 'c2c'); assert.equal(item.target, 'U_TEST'); assert.equal(item.status, 'pending');
  assert.ok(item.content.includes('【表情: [呲牙]】') && item.content.includes('👍'), item.content);
  assert.ok(item.quote?.text === '之前那条' && item.quote.from_bot);
  assert.equal(item.msg_idx, 'REFIDX_SELF'); assert.equal(item.attachments_ready, false);
  assert.equal(item.attachments.map(a => a.kind).join(), 'image,file,voice');
  for (const a of item.attachments) await dl(a, item.native_id);
  const [i, doc, voice] = item.attachments; img = i;
  assert.equal(i.status, 'downloaded'); assert.ok(fs.readFileSync(i.local_path).equals(PNG));
  assert.ok(path.basename(doc.local_path).endsWith('_课件 v26.pdf'));
  assert.ok(voice.status === 'downloaded' && voice.local_format === 'wav' && voice.local_path.endsWith('.wav') && voice.transcript === '测试语音转写');
  const day = path.basename(path.dirname(i.local_path));
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(fs.statSync(path.dirname(i.local_path)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  for (const a of item.attachments) assert.equal(fs.statSync(a.local_path).mode & 0o777, 0o600);
});

test('下载上限 / 超时 / 内网拦截', async () => {
  const r1 = normalizeAttachments([{ content_type: 'file', url: B + '/big', filename: 'x.zip', size: 2 * 1024 ** 3 }])[0];
  await dl(r1, 'm2'); assert.ok(r1.status === 'too_large' && !r1.local_path);
  const r2 = normalizeAttachments([{ content_type: 'file', url: B + '/big', filename: 'b.bin' }])[0];
  await dl(r2, 'm3', { max: 100 * 1024 }); assert.equal(r2.status, 'too_large');
  const r3 = normalizeAttachments([{ content_type: 'file', url: B + '/chunked', filename: 'c.bin' }])[0];
  await dl(r3, 'm4', { max: 100 * 1024 }); assert.equal(r3.status, 'too_large');
  for (const d of fs.readdirSync(root)) assert.ok(fs.readdirSync(path.join(root, d)).every(f => !f.includes('c.bin')), '半截文件已删');
  const r4 = normalizeAttachments([{ content_type: 'file', url: B + '/slow', filename: 's.bin' }])[0];
  await dl(r4, 'm5', { timeout: 500 }); assert.ok(r4.status === 'failed' && /超时/.test(r4.error), r4.error);
  const r5 = normalizeAttachments([{ content_type: 'image/png', url: B + '/img' }])[0];
  await dl(r5, 'm6', { allowPrivate: false }); assert.ok(r5.status === 'failed' && /内网/.test(r5.error), r5.error);
});

test('群 @ / 非 @ / 机器人 / 频道 / 频道私信 / 103 引用', () => {
  const g = ib.buildInboxItem('GROUP_AT_MESSAGE_CREATE', { id: 'G1', group_openid: 'GRP', author: { member_openid: 'M1' }, content: '<@BOTX> 你好 <@M2>', mentions: [{ member_openid: 'BOTX', is_you: true }, { member_openid: 'M2', nickname: '小明' }] }, {});
  assert.ok(g.scope === 'group' && g.target === 'GRP' && g.content === '你好 @小明' && g.status === 'pending', g.content);
  const g2 = ib.buildInboxItem('GROUP_MESSAGE_CREATE', { id: 'G2', group_openid: 'GRP', author: { member_openid: 'M1' }, content: '随便聊' }, {});
  assert.ok(g2.status === 'observed' && g2.mentioned === false);
  assert.equal(ib.buildInboxItem('GROUP_MESSAGE_CREATE', { id: 'G3', group_openid: 'GRP', author: { member_openid: 'B', bot: true }, content: 'x' }, {}), null);
  const ch = ib.buildInboxItem('AT_MESSAGE_CREATE', { id: 'C1', channel_id: 'CH', guild_id: 'GU', author: { id: 'A', username: 'u' }, content: '<@!999> hi' }, { botIds: ['999'] });
  assert.ok(ch.scope === 'channel' && ch.target === 'CH' && ch.content === 'hi');
  const dm = ib.buildInboxItem('DIRECT_MESSAGE_CREATE', { id: 'D1', guild_id: 'GU2', channel_id: 'C', author: { id: 'A' }, content: 'dm' }, {});
  assert.ok(dm.scope === 'dm' && dm.target === 'GU2');
  const q = ib.buildInboxItem('C2C_MESSAGE_CREATE', { id: 'Q1', author: { user_openid: 'U' }, content: '这个', message_type: 103, msg_elements: [{ msg_idx: 'REFIDX_Z', content: '原文', attachments: [{ content_type: 'image/png', filename: 'p.png' }] }] }, {});
  assert.ok(q.quote.ref === 'REFIDX_Z' && q.quote.source === 'msg_elements' && q.quote.text === '原文 [图片:p.png]', q.quote.text);
});

test('发送侧文件校验（不发）', async () => {
  const forbidden = makeForbidden([dir]);
  const work = tmpdir('imwb-work-'); after(() => fs.rmSync(work, { recursive: true, force: true }));
  const tmpf = path.join(work, 'ok.txt'); fs.writeFileSync(tmpf, 'hello');
  const s1 = await resolveFileSpec({ path: tmpf }, { forbidden }); assert.ok(s1.type === 'file' && s1.size === 5);
  const inner = path.join(dir, 'notes.txt'); fs.writeFileSync(inner, 'x');
  await assert.rejects(resolveFileSpec({ path: inner }, { forbidden }), /不允许/, '账号目录里 inbox-files 以外的文件都拒绝');
  const s2 = await resolveFileSpec({ path: img.local_path, type: 'image' }, { forbidden }); assert.equal(s2.type, 'image');
  const cred = path.join(dir, 'credentials.json'); fs.writeFileSync(cred, '{}', { mode: 0o600 });
  await assert.rejects(resolveFileSpec({ path: cred }, { forbidden }), /不允许/);
  const elsewhere = tmpdir('imwb-x-'); const c2 = path.join(elsewhere, 'credentials.json'); fs.writeFileSync(c2, '{}');
  await assert.rejects(resolveFileSpec({ path: c2 }, { forbidden }), /不允许/, '任何位置的 credentials.json 都拒绝');
  fs.rmSync(elsewhere, { recursive: true });
  await assert.rejects(resolveFileSpec({ path: '/nope/x.pdf' }), /不存在/);
  const bigf = path.join(work, 'huge.bin'); fs.writeFileSync(bigf, ''); fs.truncateSync(bigf, 101 * 1024 * 1024);
  await assert.rejects(resolveFileSpec({ path: bigf }), /超过 100\.0MB 上限/);
  const pngBig = path.join(work, 'big.png'); fs.writeFileSync(pngBig, ''); fs.truncateSync(pngBig, 31 * 1024 * 1024);
  const s3 = await resolveFileSpec({ path: pngBig }); assert.ok(s3.type === 'file' && s3.notes.length);
  await assert.rejects(resolveFileSpec({ url: B + '/img' }), /内网/);
  await assert.rejects(resolveFileSpec({ path: tmpf, url: 'https://x' }), /只能/);
  assert.ok(inferType('a.MP4') === 'video' && inferType('a.silk') === 'voice' && inferType('a.pptx') === 'file' && inferType('a.jpeg') === 'image');
  const fx = path.resolve('test/fixtures');
  for (const [f, t] of [['test.png', 'image'], ['test.mp4', 'video'], ['test.ogg', 'voice'], ['test.pdf', 'file']])
    assert.equal((await resolveFileSpec({ path: path.join(fx, f) })).type, t, f);
});

test('QQ 发送失败的判定', () => {
  assert.equal(qqOnSendError({ kind: 'text', attempts: 1 }, Object.assign(new Error('x'), { code: 11255 })), 'failed');
  assert.equal(qqOnSendError({ kind: 'media', stage: 'upload', media: { type: 'file' }, attempts: 1 }, new Error('文件不存在：/x')), 'failed');
  const it = { kind: 'text', reply_to: 'M1', attempts: 1 };
  assert.equal(qqOnSendError(it, new Error('timeout')), undefined); assert.equal(it.force_active, true, '被动回复失败 → 改主动');
  const v = { kind: 'media', stage: 'upload', media: { type: 'voice' }, attempts: 1 };
  qqOnSendError(v, Object.assign(new Error('bad'), { status: 400 })); assert.equal(v.media.type, 'file', '语音失败 → 按文件发');
});
