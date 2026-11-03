'use strict';
// 入站：附件下载、表情解析、@ 清理、引用索引（ref_idx）、已知用户
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA, readJSON, writeJSON } = require('./lib');
const { downloadToFile, sanitizeFileName, inferType } = require('./media');

const GB = 1024 * 1024 * 1024;
const INBOX_FILES = path.join(DATA, 'inbox-files');
const DL_MAX = Number(process.env.QQBOT_DL_MAX || GB);
const DL_TIMEOUT = Number(process.env.QQBOT_DL_TIMEOUT || 5 * 60 * 1000);

// ---------- 表情 ----------
const FACE = {"0": "\u{1F60A}","1": "\u{1F623}","2": "\u{1F60D}","4": "\u{1F60E}","5": "\u{1F62D}","6": "\u{1F633}","7": "\u{1F910}","8": "\u{1F634}","9": "\u{1F622}","10": "\u{1F630}","11": "\u{1F621}","12": "\u{1F917}","13": "\u2B50","14": "\u{1F31F}","15": "\u{1F319}","16": "\u{1F44D}","18": "\u270A","21": "\u{1F60A}","23": "\u{1F622}","25": "\u{1F914}","26": "\u{1F631}","27": "\u{1F605}","28": "\u{1F601}","29": "\u{1F92E}","30": "\u{1F4AA}","32": "\u{1F389}","33": "\u{1F624}","34": "\u{1F60F}","35": "\u{1F97A}","49": "\u{1F437}","53": "\u{1F382}","60": "\u2615","63": "\u{1F339}","66": "\u2764\uFE0F","74": "\u{1F31E}","75": "\u{1F31B}","76": "\u{1F44F}","78": "\u{1F91D}","79": "\u270C\uFE0F","85": "\u{1F385}","89": "\u{1F349}","96": "\u{1F613}","97": "\u{1F632}","100": "\u{1F602}","101": "\u{1F60A}","104": "\u{1F62D}","106": "\u{1F631}","109": "\u{1F618}","111": "\u{1F970}"};
function parseFaces(s) {
  return String(s || '')
    .replace(/\[<face,id=(\d+)\/?>]/g, (_m, id) => FACE[id] || '【表情】')
    .replace(/<faceType=\d+,faceId="([^"]*)",ext="([^"]*)">/g, (_m, id, ext) => {
      try { const j = JSON.parse(Buffer.from(ext, 'base64').toString('utf8')); return `【表情: ${j.text || FACE[id] || '未知表情'}】`; } catch { return FACE[id] || '【表情】'; }
    });
}

// ---------- @ ----------
function stripMentions(text, mentions, botIds) {
  let t = String(text || '');
  for (const m of mentions || []) {
    const id = m.member_openid || m.id || m.user_openid; if (!id) continue;
    const re = new RegExp(`<@!?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>\\s*`, 'g');
    if (m.is_you || m.bot) t = t.replace(re, ''); else if (m.nickname || m.username) t = t.replace(re, `@${m.nickname || m.username} `);
  }
  for (const b of botIds || []) if (b) t = t.replace(new RegExp(`<@!?${b}>\\s*`, 'g'), '');
  return t.trim();
}

// ---------- 引用索引 ----------
const REF_F = process.env.QQBOT_REF_FILE || path.join(DATA, 'ref-index.jsonl');
const REF_MAX = 5000;
const refMap = new Map(); let refLines = 0;
(function loadRef() {
  try {
    for (const l of fs.readFileSync(REF_F, 'utf8').split('\n')) { if (!l) continue; try { const x = JSON.parse(l); refMap.delete(x.k); refMap.set(x.k, x.v); refLines++; } catch {} }
    while (refMap.size > REF_MAX) refMap.delete(refMap.keys().next().value);
  } catch {}
})();
function refSet(k, v) {
  if (!k) return; refMap.delete(k); refMap.set(k, v); while (refMap.size > REF_MAX) refMap.delete(refMap.keys().next().value);
  try {
    fs.appendFileSync(REF_F, JSON.stringify({ k, v, t: Date.now() }) + '\n', { mode: 0o600 }); refLines++;
    if (refLines > REF_MAX * 2) { const tmp = REF_F + '.tmp'; fs.writeFileSync(tmp, [...refMap].map(([k2, v2]) => JSON.stringify({ k: k2, v: v2, t: Date.now() })).join('\n') + '\n', { mode: 0o600 }); fs.renameSync(tmp, REF_F); refLines = refMap.size; }
  } catch {}
}
function refGet(k) { return k ? refMap.get(k) || null : null; }
function parseRefs(d) {
  let msgIdx, refMsgIdx;
  for (const e of d?.message_scene?.ext || []) {
    if (typeof e !== 'string') continue; const i = e.indexOf('='); if (i < 0) continue;
    const k = e.slice(0, i).trim(), v = e.slice(i + 1).trim(); if (!v) continue;
    if (k === 'msg_idx') msgIdx = v; else if (k === 'ref_msg_idx') refMsgIdx = v;
  }
  if (d?.message_type === 103 && Array.isArray(d.msg_elements)) for (const el of d.msg_elements) if (el?.msg_idx) { refMsgIdx = el.msg_idx; break; }
  return { msgIdx, refMsgIdx };
}
function describeAtts(atts) { return (atts || []).map(a => `[${a.kind === 'image' ? '图片' : a.kind === 'voice' ? '语音' : a.kind === 'video' ? '视频' : '文件'}${a.filename ? ':' + a.filename : ''}]`).join(' '); }
function resolveQuote(d, refMsgIdx) {
  if (!refMsgIdx) return null;
  const el = Array.isArray(d.msg_elements) ? d.msg_elements[0] : null;
  if (el && (el.content || el.attachments?.length)) {
    const atts = (el.attachments || []).map(a => ({ kind: attKind(a), filename: a.filename }));
    return { ref: refMsgIdx, source: 'msg_elements', text: [parseFaces(el.content || '').trim(), describeAtts(atts)].filter(Boolean).join(' ') };
  }
  const e = refGet(refMsgIdx);
  if (e) return { ref: refMsgIdx, source: 'store', text: e.content || '[空消息]', from_bot: !!e.isBot, sender: e.senderId || null, message_id: e.messageId || null, at: e.timestamp || null };
  return { ref: refMsgIdx, source: 'none', text: '' };
}

// ---------- 已知用户 ----------
const KNOWN_F = path.join(DATA, 'known-users.json');
function touchKnown(kind, id, patch, bump = true) {
  if (!id) return;
  const k = readJSON(KNOWN_F, {}); k[kind] = k[kind] || {};
  const now = new Date().toISOString();
  const cur = k[kind][id] || { first_seen: now, count: 0 };
  for (const [kk, vv] of Object.entries(patch || {})) if (vv !== undefined) cur[kk] = vv;
  if (bump) { cur.last_seen = now; cur.count = (cur.count || 0) + 1; }
  k[kind][id] = cur; writeJSON(KNOWN_F, k, 0o600);
}
function listKnown() { return readJSON(KNOWN_F, {}); }

// ---------- 附件 ----------
function attKind(a) {
  const ct = (a.content_type || '').toLowerCase();
  if (ct === 'voice' || ct.startsWith('audio/') || /\.(silk|slk|amr)$/i.test(a.filename || '') || a.voice_wav_url || a.asr_refer_text) return 'voice';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct === 'file' || ct.startsWith('application/') || ct.startsWith('text/')) return 'file';
  return inferType(a.filename || '', ct);
}
function normUrl(u) { if (!u) return ''; return u.startsWith('//') ? 'https:' + u : u; }
const EXT_BY_CT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/wav': '.wav', 'audio/silk': '.silk', 'audio/amr': '.amr' };
function bjDate() { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date()); const g = t => p.find(x => x.type === t).value; return { day: `${g('year')}-${g('month')}-${g('day')}`, hms: `${g('hour')}${g('minute')}${g('second')}`.replace(/^24/, '00') }; }

function normalizeAttachments(list) {
  return (list || []).map(a => {
    const kind = attKind(a);
    const rec = { kind, content_type: a.content_type || null, filename: a.filename || null, size: a.size != null ? Number(a.size) : null,
      width: a.width || undefined, height: a.height || undefined, url: normUrl(a.url) || null, local_path: null, status: 'pending', error: null };
    if (kind === 'voice') { rec.voice_wav_url = normUrl(a.voice_wav_url) || null; rec.transcript = a.asr_refer_text ? String(a.asr_refer_text).trim() : null; rec.transcript_source = a.asr_refer_text ? 'qq_asr' : null; }
    return rec;
  });
}

async function downloadOne(rec, msgId, opts = {}) {
  const dl = opts.download || downloadToFile;
  const { day, hms } = bjDate();
  const dir = path.join(opts.root || INBOX_FILES, day);
  fs.mkdirSync(opts.root || INBOX_FILES, { recursive: true, mode: 0o700 }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(opts.root || INBOX_FILES, 0o700); fs.chmodSync(dir, 0o700); } catch {}
  const tries = [];
  if (rec.kind === 'voice' && rec.voice_wav_url) tries.push({ url: rec.voice_wav_url, wav: true });
  if (rec.url) tries.push({ url: rec.url });
  if (!tries.length) { rec.status = 'failed'; rec.error = '附件没有下载地址'; return rec; }
  if (rec.size != null && rec.size > (opts.max || DL_MAX)) { rec.status = 'too_large'; rec.error = `附件 ${(rec.size / 1048576).toFixed(1)}MB 超过下载上限 1GB，未下载`; return rec; }
  let lastErr;
  for (const t of tries) {
    let base = sanitizeFileName(rec.filename || `${rec.kind}${EXT_BY_CT[(rec.content_type || '').toLowerCase()] || ''}`);
    if (t.wav) base = base.replace(/\.(silk|slk|amr)$/i, '') + (/\.wav$/i.test(base) ? '' : '.wav');
    const short = crypto.createHash('md5').update(String(msgId)).digest('hex').slice(0, 6);
    let dest = path.join(dir, `${hms}_${short}_${base}`); let n = 1;
    while (fs.existsSync(dest)) dest = path.join(dir, `${hms}_${short}_${n++}_${base}`);
    try {
      const r = await dl(t.url, dest, opts.max || DL_MAX, opts.timeout || DL_TIMEOUT, opts.dlOpts || {});
      rec.local_path = dest; rec.local_size = r.size; rec.status = 'downloaded'; rec.error = null; rec.downloaded_at = new Date().toISOString();
      if (t.wav) rec.local_format = 'wav';
      if (rec.size == null) rec.size = r.size;
      return rec;
    } catch (e) { lastErr = e; if (/超过/.test(e.message)) { rec.status = 'too_large'; rec.error = e.message; return rec; } }
  }
  rec.status = 'failed'; rec.error = lastErr ? lastErr.message : '下载失败';
  return rec;
}
async function downloadAll(recs, msgId, opts) { await Promise.all(recs.map(r => downloadOne(r, msgId, opts))); return recs; }

// 把网关事件转成收件箱条目（不含 IO 副作用之外的下载）
function buildInboxItem(t, d, ctx = {}) {
  let scope, target, author, mentioned = true, extra = {};
  if (t === 'C2C_MESSAGE_CREATE') { scope = 'c2c'; target = d.author?.user_openid; author = target; }
  else if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
    scope = 'group'; target = d.group_openid; author = d.author?.member_openid;
    mentioned = t === 'GROUP_AT_MESSAGE_CREATE' || (d.mentions || []).some(m => m.is_you);
    if (d.author?.bot) return null;
  } else if (t === 'AT_MESSAGE_CREATE') { scope = 'channel'; target = d.channel_id; author = d.author?.id; extra = { guild_id: d.guild_id, channel_id: d.channel_id, author_name: d.author?.username }; if (d.author?.bot) return null; }
  else if (t === 'DIRECT_MESSAGE_CREATE') { scope = 'dm'; target = d.guild_id; author = d.author?.id; extra = { guild_id: d.guild_id, channel_id: d.channel_id, src_guild_id: d.src_guild_id, author_name: d.author?.username }; if (d.author?.bot) return null; }
  else return null;
  const raw = (d.content || '');
  const content = parseFaces(stripMentions(raw, d.mentions, ctx.botIds)).trim();
  const { msgIdx, refMsgIdx } = parseRefs(d);
  const attachments = normalizeAttachments(d.attachments);
  const item = { id: d.id, scope, target, author, content, raw_content: raw !== content ? raw : undefined, attachments,
    attachments_ready: attachments.length === 0, mentioned, ...extra,
    msg_idx: msgIdx || undefined, quote: resolveQuote(d, refMsgIdx) || undefined, event: t,
    msg_ts: d.timestamp ? Date.parse(d.timestamp) || Date.now() : Date.now(), received_at: new Date().toISOString(),
    status: mentioned ? 'pending' : 'observed', auto_acked: false };
  return item;
}
function rememberInbound(item) {
  if (!item.msg_idx) return;
  refSet(item.msg_idx, { messageId: item.id, content: [item.content, describeAtts(item.attachments)].filter(Boolean).join(' '), senderId: item.author, timestamp: new Date(item.msg_ts).toISOString(), isBot: false, scope: item.scope });
}

module.exports = { parseFaces, stripMentions, parseRefs, resolveQuote, refSet, refGet, touchKnown, listKnown, normalizeAttachments, downloadOne, downloadAll, buildInboxItem, rememberInbound, attKind, INBOX_FILES };
