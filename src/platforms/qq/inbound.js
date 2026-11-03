// QQ 入站解析：表情、@ 清理、引用索引（ref_idx）、已知用户、附件规范化
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON } from '../../util.js';
import { inferType } from '../../core/media.js';
import { describeAtts } from '../../core/attachments.js';

const FACE = {"0": "\u{1F60A}","1": "\u{1F623}","2": "\u{1F60D}","4": "\u{1F60E}","5": "\u{1F62D}","6": "\u{1F633}","7": "\u{1F910}","8": "\u{1F634}","9": "\u{1F622}","10": "\u{1F630}","11": "\u{1F621}","12": "\u{1F917}","13": "\u2B50","14": "\u{1F31F}","15": "\u{1F319}","16": "\u{1F44D}","18": "\u270A","21": "\u{1F60A}","23": "\u{1F622}","25": "\u{1F914}","26": "\u{1F631}","27": "\u{1F605}","28": "\u{1F601}","29": "\u{1F92E}","30": "\u{1F4AA}","32": "\u{1F389}","33": "\u{1F624}","34": "\u{1F60F}","35": "\u{1F97A}","49": "\u{1F437}","53": "\u{1F382}","60": "\u2615","63": "\u{1F339}","66": "\u2764\uFE0F","74": "\u{1F31E}","75": "\u{1F31B}","76": "\u{1F44F}","78": "\u{1F91D}","79": "\u270C\uFE0F","85": "\u{1F385}","89": "\u{1F349}","96": "\u{1F613}","97": "\u{1F632}","100": "\u{1F602}","101": "\u{1F60A}","104": "\u{1F62D}","106": "\u{1F631}","109": "\u{1F618}","111": "\u{1F970}"};

export function parseFaces(s) {
  return String(s || '')
    .replace(/\[<face,id=(\d+)\/?>]/g, (_m, id) => FACE[id] || '【表情】')
    .replace(/<faceType=\d+,faceId="([^"]*)",ext="([^"]*)">/g, (_m, id, ext) => {
      try { const j = JSON.parse(Buffer.from(ext, 'base64').toString('utf8')); return `【表情: ${j.text || FACE[id] || '未知表情'}】`; } catch { return FACE[id] || '【表情】'; }
    });
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function stripMentions(text, mentions, botIds) {
  let t = String(text || '');
  for (const m of mentions || []) {
    const id = m.member_openid || m.id || m.user_openid; if (!id) continue;
    const re = new RegExp(`<@!?${esc(id)}>\\s*`, 'g');
    if (m.is_you || m.bot) t = t.replace(re, ''); else if (m.nickname || m.username) t = t.replace(re, `@${m.nickname || m.username} `);
  }
  for (const b of botIds || []) if (b) t = t.replace(new RegExp(`<@!?${esc(String(b))}>\\s*`, 'g'), '');
  return t.trim();
}

export function parseRefs(d) {
  let msgIdx, refMsgIdx;
  for (const e of d?.message_scene?.ext || []) {
    if (typeof e !== 'string') continue; const i = e.indexOf('='); if (i < 0) continue;
    const k = e.slice(0, i).trim(), v = e.slice(i + 1).trim(); if (!v) continue;
    if (k === 'msg_idx') msgIdx = v; else if (k === 'ref_msg_idx') refMsgIdx = v;
  }
  if (d?.message_type === 103 && Array.isArray(d.msg_elements)) for (const el of d.msg_elements) if (el?.msg_idx) { refMsgIdx = el.msg_idx; break; }
  return { msgIdx, refMsgIdx };
}

export function attKind(a) {
  const ct = (a.content_type || '').toLowerCase();
  if (ct === 'voice' || ct.startsWith('audio/') || /\.(silk|slk|amr)$/i.test(a.filename || '') || a.voice_wav_url || a.asr_refer_text) return 'voice';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct === 'file' || ct.startsWith('application/') || ct.startsWith('text/')) return 'file';
  return inferType(a.filename || '', ct);
}
const normUrl = u => (!u ? '' : u.startsWith('//') ? 'https:' + u : u);

export function normalizeAttachments(list) {
  return (list || []).map(a => {
    const kind = attKind(a);
    const rec = { kind, content_type: a.content_type || null, filename: a.filename || null, size: a.size != null ? Number(a.size) : null,
      width: a.width || undefined, height: a.height || undefined, url: normUrl(a.url) || null, local_path: null, status: 'pending', error: null };
    if (kind === 'voice') { rec.voice_wav_url = normUrl(a.voice_wav_url) || null; rec.transcript = a.asr_refer_text ? String(a.asr_refer_text).trim() : null; rec.transcript_source = a.asr_refer_text ? 'qq_asr' : null; }
    return rec;
  });
}

// 下载源：语音优先 wav，再原始 url
export function attachmentSources(rec, { allowPrivate = false } = {}) {
  const s = [];
  if (rec.kind === 'voice' && rec.voice_wav_url) s.push({ url: rec.voice_wav_url, wav: true, allowPrivate });
  if (rec.url) s.push({ url: rec.url, allowPrivate });
  return s;
}

// 每个账号一份：引用索引 + 已知用户都在账号目录里
export function createInbound(dir) {
  const REF_F = path.join(dir, 'ref-index.jsonl');
  const KNOWN_F = path.join(dir, 'known-users.json');
  const REF_MAX = 5000;
  const refMap = new Map(); let refLines = 0;
  try {
    for (const l of fs.readFileSync(REF_F, 'utf8').split('\n')) { if (!l) continue; try { const x = JSON.parse(l); refMap.delete(x.k); refMap.set(x.k, x.v); refLines++; } catch {} }
    while (refMap.size > REF_MAX) refMap.delete(refMap.keys().next().value);
  } catch {}
  function refSet(k, v) {
    if (!k) return; refMap.delete(k); refMap.set(k, v); while (refMap.size > REF_MAX) refMap.delete(refMap.keys().next().value);
    try {
      fs.appendFileSync(REF_F, JSON.stringify({ k, v, t: Date.now() }) + '\n', { mode: 0o600 }); refLines++;
      if (refLines > REF_MAX * 2) { const tmp = REF_F + '.tmp'; fs.writeFileSync(tmp, [...refMap].map(([k2, v2]) => JSON.stringify({ k: k2, v: v2, t: Date.now() })).join('\n') + '\n', { mode: 0o600 }); fs.renameSync(tmp, REF_F); refLines = refMap.size; }
    } catch {}
  }
  const refGet = k => (k ? refMap.get(k) || null : null);

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

  function touchKnown(kind, id, patch, bump = true) {
    if (!id) return;
    const k = readJSON(KNOWN_F, {}); k[kind] = k[kind] || {};
    const now = new Date().toISOString();
    const cur = k[kind][id] || { first_seen: now, count: 0 };
    for (const [kk, vv] of Object.entries(patch || {})) if (vv !== undefined) cur[kk] = vv;
    if (bump) { cur.last_seen = now; cur.count = (cur.count || 0) + 1; }
    k[kind][id] = cur; writeJSON(KNOWN_F, k, 0o600);
  }
  const listKnown = () => readJSON(KNOWN_F, {});

  // 网关事件 → 收件条目（native_id 是 QQ 消息 id；全局 id 由核心层加账号前缀）
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
    const raw = d.content || '';
    const content = parseFaces(stripMentions(raw, d.mentions, ctx.botIds)).trim();
    const { msgIdx, refMsgIdx } = parseRefs(d);
    const attachments = normalizeAttachments(d.attachments);
    return { native_id: d.id, scope, target, author, content, raw_content: raw !== content ? raw : undefined, attachments,
      attachments_ready: attachments.length === 0, mentioned, ...extra,
      msg_idx: msgIdx || undefined, quote: resolveQuote(d, refMsgIdx) || undefined, event: t,
      msg_ts: d.timestamp ? Date.parse(d.timestamp) || Date.now() : Date.now(), received_at: new Date().toISOString(),
      status: mentioned ? 'pending' : 'observed' };
  }
  function rememberInbound(item) {
    if (!item.msg_idx) return;
    refSet(item.msg_idx, { messageId: item.native_id, content: [item.content, describeAtts(item.attachments)].filter(Boolean).join(' '), senderId: item.author, timestamp: new Date(item.msg_ts).toISOString(), isBot: false, scope: item.scope });
  }
  return { refSet, refGet, resolveQuote, touchKnown, listKnown, buildInboxItem, rememberInbound };
}
