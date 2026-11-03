'use strict';
// QQ 开放平台机器人网关：token 自动刷新 + WebSocket（C2C 私聊 + 群 @）+ 心跳 watchdog + 收件箱/发件队列 + 本地接口
// 协议参考 ref-openclaw-qqbot（@tencent-connect/openclaw-qqbot 2.0.4）
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');
const { P, DATA, PORT, HOST, makeLogger, readJSON, writeJSON, readJSONL, writeJSONL } = require('./lib');
const media = require('./media');
const inbound = require('./inbound');
const log = makeLogger('gw');
const hook = require('./webhook').create({ dataDir: DATA, log });

const API = process.env.QQBOT_BASE_URL || 'https://api.sgroup.qq.com';
const TOKEN_URL = (process.env.QQBOT_TOKEN_BASE_URL || 'https://bots.qq.com') + '/app/getAppAccessToken';
const INTENTS = (1 << 25) | (1 << 12) | (1 << 30); // GROUP_AND_C2C | DIRECT_MESSAGE | PUBLIC_GUILD_MESSAGES
const AUTO_ACK_TEXT = process.env.QQBOT_AUTO_ACK || '收到，正在处理…';
const CHUNK = 1800;
const MAX_ATTEMPTS = 12;
const PASSIVE_WINDOW_MS = { c2c: 55 * 60 * 1000, group: 4.5 * 60 * 1000, channel: 4.5 * 60 * 1000, dm: 4.5 * 60 * 1000 };
const EVENTS_F = require('path').join(DATA, 'events.jsonl');
const VERSION = '2.2-macmini';

const creds = readJSON(P.creds);
// launchd 下无凭证按正常退出（KeepAlive SuccessfulExit=false 不会反复拉起）
if (!creds || !creds.appId || !creds.appSecret) { log('没有凭证，退出（先跑 node bind.js）'); process.exit(process.env.QQBOT_UNDER_LAUNCHD ? 0 : 2); }

const state = { started_at: new Date().toISOString(), ws: 'init', session_id: null, seq: null, bot: null,
  last_hello: null, last_ready: null, last_heartbeat_sent: null, last_ack: null, last_event: null,
  reconnects: 0, resume_failures: 0, last_error: null, token_expires_at: null, received: 0, sent: 0,
  last_healthy: Date.now(), conn_started_at: null, clock_jumps: 0, last_clock_jump: null };
const sess = readJSON(P.session) || {};
if (sess.session_id) { state.session_id = sess.session_id; state.seq = sess.seq ?? null; }
if (sess.bot) state.bot = sess.bot;
function saveSession() { try { writeJSON(P.session, { session_id: state.session_id, seq: state.seq, bot: state.bot }, 0o600); } catch {} }

// ---------- token ----------
let token = null, tokenExp = 0, tokenPromise = null;
async function fetchToken() {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: creds.appId, clientSecret: creds.appSecret }), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`token HTTP ${r.status} code=${j.code ?? ''} ${j.message ?? ''}`);
    token = j.access_token; tokenExp = Date.now() + Number(j.expires_in || 7200) * 1000;
    state.token_expires_at = new Date(tokenExp).toISOString();
    log('access_token 已刷新，有效到', state.token_expires_at);
    return token;
  } finally { clearTimeout(t); }
}
async function getToken(force) {
  const ahead = Math.min(5 * 60 * 1000, (tokenExp - Date.now()) / 3);
  if (!force && token && Date.now() < tokenExp - ahead) return token;
  if (!tokenPromise) tokenPromise = fetchToken().finally(() => { tokenPromise = null; });
  return tokenPromise;
}
// token 独立定时器：每 30s 按墙钟检查（休眠/冻结醒来后第一次 tick 就会刷新），另在到期前 5 分钟精确定时刷新一次
let tokenTimer = null;
function tokenTick() {
  getToken().then(() => {
    if (tokenTimer) clearTimeout(tokenTimer);
    const at = Math.max(30 * 1000, tokenExp - Date.now() - 5 * 60 * 1000);
    tokenTimer = setTimeout(tokenTick, Math.min(at, 2 ** 31 - 1));
  }).catch(e => { state.last_error = 'token: ' + e.message; log(state.last_error); });
}
setInterval(tokenTick, 30 * 1000);

async function api(method, path, body, opts = {}) {
  for (let i = 0; i < 2; i++) {
    const tk = await getToken(i > 0);
    const ms = opts.timeoutMs || 20000;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try {
      let r;
      try {
        r = await fetch(API + path, { method, signal: ctl.signal,
          headers: { Authorization: `QQBot ${tk}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      } catch (e) { if (e.name === 'AbortError') { const x = new Error(`请求超时（${Math.round(ms / 1000)}s）${path.replace(/\/[A-F0-9]{32}\b/g, '/…')}`); x.timeout = true; throw x; } throw e; }
      const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
      if (r.status === 401 && i === 0) continue;
      const biz = j.code ?? j.err_code;
      if (!r.ok || (biz && biz !== 0 && !j.id && !j.file_info && !j.upload_id)) {
        const e = new Error(`API ${r.status} code=${biz ?? ''} ${j.message ?? text.slice(0, 200)}`); e.code = biz; e.status = r.status; throw e;
      }
      return j;
    } finally { clearTimeout(t); }
  }
}

// ---------- inbox ----------
function appendInbox(item) { const all = readJSONL(P.inbox); all.push(item); writeJSONL(P.inbox, all); }
function updateInbox(id, patch) { const all = readJSONL(P.inbox); const it = all.find(x => x.id === id); if (it) Object.assign(it, patch); writeJSONL(P.inbox, all); return it; }

// ---------- outbox ----------
// msg_seq：同一 msg_id 下递增，起点随机（重启后不撞号，参考官方插件 getNextMsgSeq）
const seqCounter = new Map();
function nextSeq(msgId) { let n = seqCounter.get(msgId); n = n == null ? (Date.now() % 1e8 ^ crypto.randomInt(65536)) % 60000 + 1 : n + 1; seqCounter.set(msgId, n); return n % 65536 || 1; }
function splitText(s) { const out = []; let t = String(s); while (t.length > CHUNK) { let cut = t.lastIndexOf('\n', CHUNK); if (cut < CHUNK * 0.5) cut = CHUNK; out.push(t.slice(0, cut)); t = t.slice(cut).replace(/^\n/, ''); } if (t) out.push(t); return out; }
function newId(i) { return 'o_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex') + '_' + i; }
// enqueue：content 先发（分段），files 逐个跟在后面
function enqueue({ scope, target, content, files, msg_id, msg_ts, inbox_id, markdown, quote, extra }) {
  const all = readJSONL(P.outbox);
  const base = { scope, target, msg_id: msg_id || null, msg_ts: msg_ts || null, inbox_id: inbox_id || null, ...(extra || {}),
    status: 'pending', attempts: 0, next_at: Date.now(), created_at: new Date().toISOString(), last_error: null };
  const parts = content ? splitText(content) : [];
  const total = parts.length + (files || []).length; let k = 0;
  const items = [];
  parts.forEach((c, i) => items.push({ ...base, id: newId(k), kind: 'text', content: c, markdown: !!markdown, quote: !!quote && i === 0, part: ++k, parts: total }));
  (files || []).forEach(f => items.push({ ...base, id: newId(k), kind: 'media', media: f, part: ++k, parts: total }));
  all.push(...items); writeJSONL(P.outbox, all); setImmediate(drain); return items;
}
function msgPath(scope, target) {
  return scope === 'group' ? `/v2/groups/${target}/messages` : scope === 'channel' ? `/channels/${target}/messages` : scope === 'dm' ? `/dms/${target}/messages` : `/v2/users/${target}/messages`;
}
async function sendOne(it) {
  const passiveOk = it.msg_id && !it.force_active && it.msg_ts && (Date.now() - it.msg_ts) < (PASSIVE_WINDOW_MS[it.scope] || PASSIVE_WINDOW_MS.group);
  const guild = it.scope === 'channel' || it.scope === 'dm';
  let body;
  if (it.kind === 'media') {
    if (!it.file_info || (it.file_info_exp && it.file_info_exp < Date.now())) {
      it.stage = 'upload';
      const up = await media.uploadMedia(api, it.scope, it.target, it.media, log);
      it.file_info = up.file_info; it.file_info_exp = up.ttl > 0 ? Date.now() + (up.ttl - 120) * 1000 : Date.now() + 30 * 60 * 1000; it.upload_via = up.via;
    }
    it.stage = 'send';
    body = { msg_type: 7, media: { file_info: it.file_info } };
    if (it.media.caption) body.content = it.media.caption;
  } else if (guild) {
    body = { content: it.content };
  } else if (it.markdown && !it.markdown_failed) {
    body = { msg_type: 2, markdown: { content: it.content } };
  } else {
    body = { content: it.content, msg_type: 0 };
  }
  it.stage = 'send';
  if (passiveOk) { body.msg_id = it.msg_id; if (!guild) body.msg_seq = nextSeq(it.msg_id); if (it.quote && !it.quote_failed) body.message_reference = { message_id: it.msg_id }; }
  else if (!guild) { body.msg_seq = nextSeq('active:' + it.target); if (it.scope === 'c2c' && it.wakeup) body.is_wakeup = true; }
  const r = await api('POST', msgPath(it.scope, it.target), body);
  it.mode = passiveOk ? 'passive' : 'active';
  return r;
}
const PERMANENT_CODES = new Set([11255]); // 用户/群不存在或已注销：不再重试
let draining = false;
async function drain() {
  if (draining) return; draining = true;
  try {
    const due = readJSONL(P.outbox).filter(x => x.status === 'pending' && x.next_at <= Date.now());
    for (const it0 of due) {
      const cur = readJSONL(P.outbox).find(x => x.id === it0.id);
      if (!cur || cur.status !== 'pending') continue;
      const it = cur;
      try {
        const r = await sendOne(it);
        it.status = 'sent'; it.sent_at = new Date().toISOString(); it.sent_msg_id = r?.id || null; it.last_error = null; delete it.stage; state.sent++;
        const refIdx = r?.ext_info?.ref_idx;
        if (refIdx) inbound.refSet(refIdx, { messageId: r.id, content: it.kind === 'media' ? `[${it.media.type === 'image' ? '图片' : it.media.type === 'voice' ? '语音' : it.media.type === 'video' ? '视频' : '文件'}:${it.media.name}]` : it.content, senderId: creds.appId, senderName: state.bot?.username, timestamp: new Date().toISOString(), isBot: true, scope: it.scope });
        if (it.kind === 'media') log('已发送', it.media.type, it.media.name, it.upload_via || '', it.mode);
      } catch (e) {
        it.attempts++; it.last_error = e.message;
        const passiveTried = it.msg_id && !it.force_active;
        if (it.kind === 'media' && it.stage === 'upload') {
          if (/文件不存在|ENOENT/.test(e.message)) { it.status = 'failed'; }
          else if ((it.media.type === 'voice' || it.media.type === 'video') && !it.fallback_tried && (e.voiceFallback || (e.status >= 400 && e.status < 500))) {
            it.fallback_tried = true; it.media = { ...it.media, type: 'file', notes: [...(it.media.notes || []), `${it.media.type} 发送失败，改按文件发`] }; it.file_info = null; it.attempts = Math.max(0, it.attempts - 1);
          }
        } else {
          if (it.kind === 'media' && it.attempts >= 2) it.file_info = null; // file_info 可能失效，下次重新上传
          if (it.markdown && !it.markdown_failed && e.code) it.markdown_failed = true;      // markdown 无权限 → 纯文本
          else if (it.quote && !it.quote_failed && e.code && passiveTried) it.quote_failed = true; // 引用失败 → 去掉引用
          else if (passiveTried) it.force_active = true;                                       // 被动失败（过期/次数用完）→ 主动
          if (!passiveTried && it.scope === 'c2c' && !it.wakeup && it.attempts >= 2) it.wakeup = true;
        }
        if (PERMANENT_CODES.has(e.code)) it.status = 'failed';
        if (it.status !== 'failed') {
          if (it.attempts >= MAX_ATTEMPTS) it.status = 'failed';
          else it.next_at = Date.now() + (it.attempts <= 1 ? 1000 : Math.min(30 * 60 * 1000, 2000 * 2 ** (it.attempts - 1)));
        }
        log('发送失败', it.id, it.kind, `attempt ${it.attempts}`, e.message);
      }
      writeJSONL(P.outbox, mergeOutbox(it));
    }
  } catch (e) { log('drain error', e.message); }
  finally { draining = false; }
}
function mergeOutbox(it) { const all = readJSONL(P.outbox); const i = all.findIndex(x => x.id === it.id); if (i >= 0) all[i] = it; return all; }
setInterval(drain, 3000);

// ---------- WebSocket ----------
let ws = null, hbTimer = null, hbInterval = 41250, reconnectTimer = null, attempts = 0, connecting = false, awakeSinceHealthy = 0, connGen = 0;
const DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
function stopHeartbeat() { if (hbTimer) clearInterval(hbTimer); hbTimer = null; }
function cleanup() { stopHeartbeat(); if (ws) { const w = ws; ws = null; try { w.removeAllListeners(); w.on('error', () => {}); w.terminate(); } catch {} } ws = null; }
// 心跳：Hello 时启动，READY/RESUMED 后再重启一次并立刻补发一次（保证每次连上都有心跳在跑）
function heartbeatOnce() {
  if (!ws || ws.readyState !== WebSocket.OPEN) { log('心跳时发现 WS 未打开，重连'); forceReconnect(1000); return; }
  send({ op: 1, d: state.seq }); state.last_heartbeat_sent = Date.now();
}
function startHeartbeat(immediate) {
  stopHeartbeat();
  hbTimer = setInterval(heartbeatOnce, hbInterval);
  if (immediate) heartbeatOnce();
}
function forceReconnect(delay) { if (state.ws === 'resuming') state.resume_failures++; connGen++; cleanup(); connecting = false; schedule(delay); }
function markHealthy() { state.last_ack = Date.now(); state.last_healthy = Date.now(); awakeSinceHealthy = 0; }
function schedule(delay) {
  if (reconnectTimer) return;
  const d = delay ?? DELAYS[Math.min(attempts, DELAYS.length - 1)]; attempts++; state.reconnects++;
  state.ws = 'reconnecting'; log(`${d}ms 后重连（第 ${attempts} 次）`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, d);
}
async function connect() {
  if (connecting) return; connecting = true; cleanup(); state.ws = 'connecting'; state.conn_started_at = Date.now();
  const my = ++connGen;
  try {
    const g = await api('GET', '/gateway');
    const tk = await getToken();
    if (my !== connGen) return; // 期间被看门狗判定卡住并已另起重连，这次作废
    const w = new WebSocket(g.url, { handshakeTimeout: 20000 }); ws = w;
    // 只处理当前这条连接的事件，旧连接的迟到事件一律忽略
    w.on('open', () => { if (ws !== w) return; connecting = false; log('WS 已连接'); });
    w.on('message', raw => { if (ws !== w) return; let p; try { p = JSON.parse(raw.toString()); } catch { return; } onPayload(p, tk); });
    w.on('close', (code, reason) => { if (ws !== w) return; connecting = false; log('WS 关闭', code, reason.toString()); onClose(code); });
    w.on('error', e => { if (ws !== w) return; state.last_error = 'ws: ' + e.message; log('WS 错误', e.message); });
  } catch (e) {
    if (my !== connGen) return;
    connecting = false; state.last_error = 'connect: ' + e.message; log('连接失败', e.message);
    schedule(/100001|Too many/.test(e.message) ? 60000 : undefined);
  }
}
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function onPayload(p, tk) {
  if (p.s != null) { state.seq = p.s; }
  switch (p.op) {
    case 10: { // Hello：清心跳状态，identify 或 resume
      state.last_hello = Date.now(); state.last_ack = Date.now(); state.last_heartbeat_sent = null;
      hbInterval = p.d?.heartbeat_interval || 41250;
      if (state.session_id && state.seq != null && state.resume_failures < 2) {
        state.ws = 'resuming'; send({ op: 6, d: { token: `QQBot ${tk}`, session_id: state.session_id, seq: state.seq } });
      } else {
        state.ws = 'identifying'; send({ op: 2, d: { token: `QQBot ${tk}`, intents: INTENTS, shard: [0, 1] } });
      }
      startHeartbeat(false);
      break;
    }
    case 11: markHealthy(); break;
    case 7: log('服务端要求重连'); forceReconnect(1000); break;
    case 9: log('INVALID_SESSION，重新 identify'); state.session_id = null; state.seq = null; saveSession(); forceReconnect(2000); break;
    case 0: onDispatch(p.t, p.d); break;
  }
}
function onDispatch(t, d) {
  state.last_event = Date.now();
  if (t === 'READY') {
    state.session_id = d.session_id; state.bot = d.user ? { id: d.user.id, username: d.user.username } : null;
    state.ws = 'ready'; state.last_ready = Date.now(); state.resume_failures = 0; markHealthy(); attempts = 0; saveSession();
    startHeartbeat(true); log('READY', state.bot?.username || ''); return;
  }
  if (t === 'RESUMED') { if (!state.bot) api('GET', '/users/@me').then(u => { state.bot = { id: u.id, username: u.username }; saveSession(); }).catch(() => {}); state.ws = 'ready'; state.last_ready = Date.now(); state.resume_failures = 0; markHealthy(); attempts = 0; startHeartbeat(true); log('RESUMED'); saveSession(); return; }
  saveSession();
  if (['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE'].includes(t)) return onMessage(t, d);
  if (LIFECYCLE.includes(t)) return onLifecycle(t, d);
}
const LIFECYCLE = ['FRIEND_ADD', 'FRIEND_DEL', 'C2C_MSG_REJECT', 'C2C_MSG_RECEIVE', 'GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MSG_REJECT', 'GROUP_MSG_RECEIVE'];
function onLifecycle(t, d) {
  const ev = { type: t, at: new Date().toISOString(), openid: d.openid || d.user_openid || null, group_openid: d.group_openid || null, op_member_openid: d.op_member_openid || null, event_id: d.id || null, timestamp: d.timestamp || null };
  try { fs.appendFileSync(EVENTS_F, JSON.stringify(ev) + '\n', { mode: 0o600 }); } catch {}
  if (t.startsWith('FRIEND') || t.startsWith('C2C')) inbound.touchKnown('c2c', ev.openid, { friend: t === 'FRIEND_DEL' ? false : t === 'FRIEND_ADD' ? true : undefined, proactive_allowed: t === 'C2C_MSG_REJECT' ? false : t === 'C2C_MSG_RECEIVE' ? true : undefined }, false);
  else inbound.touchKnown('group', ev.group_openid, { in_group: t === 'GROUP_DEL_ROBOT' ? false : t === 'GROUP_ADD_ROBOT' ? true : undefined, proactive_allowed: t === 'GROUP_MSG_REJECT' ? false : t === 'GROUP_MSG_RECEIVE' ? true : undefined }, false);
  log('事件', t);
}
function onMessage(t, d) {
  if (readJSONL(P.inbox).some(x => x.id === d.id)) return;
  const item = inbound.buildInboxItem(t, d, { botIds: [state.bot?.id, creds.appId] });
  if (!item) return;
  appendInbox(item); state.received++;
  inbound.rememberInbound(item);
  if (item.scope === 'c2c') inbound.touchKnown('c2c', item.target);
  else if (item.scope === 'group') inbound.touchKnown('group', item.target, { last_member: item.author });
  else inbound.touchKnown(item.scope, item.target, { guild_id: item.guild_id });
  log('收到消息', item.scope, item.mentioned ? '' : '(未@，仅记录)', `附件${item.attachments.length}`);
  if (item.status === 'pending' && AUTO_ACK_TEXT) { enqueue({ scope: item.scope, target: item.target, content: AUTO_ACK_TEXT, msg_id: item.id, msg_ts: item.msg_ts, inbox_id: item.id }); updateInbox(item.id, { auto_acked: true }); }
  const wantHook = item.status === 'pending';
  if (item.attachments.length) {
    inbound.downloadAll(item.attachments, item.id).then(recs => {
      const it = updateInbox(item.id, { attachments: recs, attachments_ready: true });
      log('附件处理完', item.id.slice(-8), recs.map(r => `${r.kind}:${r.status}`).join(','));
      if (wantHook) hook.push(it || item);
    }).catch(e => { const it = updateInbox(item.id, { attachments_ready: true, attachments_error: e.message }); log('附件下载异常', e.message); if (wantHook) hook.push(it || item); });
  } else if (wantHook) hook.push(item);
}
function onClose(code) {
  cleanup();
  if (code === 4914 || code === 4915) { state.ws = 'fatal'; state.last_error = `close ${code}: 机器人被下线/封禁或仅沙箱`; log(state.last_error); schedule(10 * 60 * 1000); return; }
  if (code === 4004) { token = null; tokenExp = 0; }
  if ([4006, 4007, 4009].includes(code)) { state.session_id = null; state.seq = null; saveSession(); }
  if (state.ws === 'resuming') state.resume_failures++;
  if (state.resume_failures >= 2) { state.session_id = null; state.seq = null; saveSession(); }
  schedule(code === 4008 ? 60000 : undefined);
}
// ---------- 看门狗（每 5s） ----------
// 软：ACK（墙钟）超过 2.5 个心跳周期 → 重连；握手/连接卡住 60s → 重连；墙钟跳变（休眠/冻结醒来）→ 立刻刷 token、补发心跳。
// 硬：「醒着的时间」累计超过 3 个心跳周期 + 60s 仍没有 ACK/READY/RESUMED → process.exit(1)，交给 launchd/supervise 拉起。
//     醒着的时间 = 每次 tick 的间隔（正常最多记 10s；两次 tick 隔了 15s 以上视为休眠/冻结，只记 5s），
//     所以机器休眠/冻结醒来不会误杀，醒来后连不上、或真卡死，3 个心跳周期 + 60s（约 3 分钟）内一定会被杀并重启。
const WD_TICK = 5000;
const HARD_EXTRA_MS = Number(process.env.QQBOT_HARD_WATCHDOG_EXTRA_MS || 60000);
let lastTick = Date.now();
function hardLimitMs() { return hbInterval * 3 + HARD_EXTRA_MS; }
function ackStale() { return state.ws === 'ready' && state.last_ack != null && (Date.now() - state.last_ack) > hbInterval * 2.5; }
function watchdogTick(fromHealth) {
  const now = Date.now(), gap = now - lastTick;
  const jumped = !fromHealth && gap > 3 * WD_TICK; // 两个 tick 之间隔了 15s 以上：进程被冻结/机器休眠过
  if (!fromHealth) { lastTick = now; awakeSinceHealthy += jumped ? WD_TICK : Math.min(Math.max(gap, 0), 2 * WD_TICK); }
  if (jumped) {
    state.clock_jumps++; state.last_clock_jump = new Date().toISOString();
    log(`墙钟跳了 ${Math.round(gap / 1000)}s（机器休眠/冻结后醒来），立刻检查 token 和连接`);
    tokenTick();
    if (ws && state.ws === 'ready') heartbeatOnce();
  }
  if (awakeSinceHealthy > hardLimitMs()) {
    log(`看门狗：已 ${Math.round(awakeSinceHealthy / 1000)}s 没有 ACK/READY/RESUMED（上限 ${Math.round(hardLimitMs() / 1000)}s），退出让守护进程重启`);
    process.exit(1);
  }
  if (connecting && state.conn_started_at && now - state.conn_started_at > 60000) { log('连接过程卡住超过 60s，强制重连'); forceReconnect(1000); return; }
  if (!ws || connecting) { if (!ws && !reconnectTimer && !connecting) schedule(); return; }
  if (ackStale()) { log('心跳 ACK 陈旧，强制重连'); forceReconnect(1000); return; }
  const since = Math.max(state.last_hello || 0, state.conn_started_at || 0);
  if (state.ws !== 'ready' && since && now - since > 60000) { log('握手卡住，强制重连'); forceReconnect(1000); return; }
  if (state.ws === 'ready' && !hbTimer) { log('心跳定时器不在，重新启动'); startHeartbeat(true); }
}
setInterval(() => { try { watchdogTick(false); } catch (e) { log('watchdog 异常', e.message); } }, WD_TICK);

// 日志轮转：launchd 以追加方式打开 logs/gateway.log，超过 20MB 就拷到 .1 再截断
setInterval(() => {
  for (const name of ['gateway.log', 'gateway.err.log']) {
    const f = require('path').join(require('./lib').LOGS, name);
    try { if (fs.statSync(f).size > 20 * 1024 * 1024) { fs.copyFileSync(f, f + '.1'); fs.truncateSync(f, 0); log('日志已轮转', name); } } catch {}
  }
}, 60 * 60 * 1000);

// ---------- 本地接口 ----------
function body(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const J = (code, o) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/health') {
      const ob = readJSONL(P.outbox);
      const stale = ackStale(), tokenValid = !!token && Date.now() < tokenExp;
      if (stale || !tokenValid) setImmediate(() => { try { if (!tokenValid) tokenTick(); watchdogTick(true); } catch {} }); // 被查到异常就立刻自愈，不等下一个 tick
      return J(200, { ok: state.ws === 'ready' && !stale && tokenValid, mode: 'gateway', ws: state.ws, stale, app_id: creds.appId, bot: state.bot, pid: process.pid, started_at: state.started_at,
        last_ack_age_s: state.last_ack ? Math.round((Date.now() - state.last_ack) / 1000) : null, reconnects: state.reconnects,
        heartbeat_running: !!hbTimer, heartbeat_interval_s: Math.round(hbInterval / 1000),
        last_heartbeat_sent_age_s: state.last_heartbeat_sent ? Math.round((Date.now() - state.last_heartbeat_sent) / 1000) : null,
        watchdog_unhealthy_s: Math.round(awakeSinceHealthy / 1000), watchdog_limit_s: Math.round(hardLimitMs() / 1000), clock_jumps: state.clock_jumps,
        token_expires_at: state.token_expires_at, token_valid: tokenValid, webhook: hook.status(), received: state.received, sent: state.sent,
        pending_inbox: readJSONL(P.inbox).filter(x => x.status === 'pending').length,
        outbox_pending: ob.filter(x => x.status === 'pending').length, outbox_failed: ob.filter(x => x.status === 'failed').length, last_error: state.last_error,
        attachments_downloading: readJSONL(P.inbox).filter(x => x.attachments_ready === false).length, version: VERSION });
    }
    if (u.pathname === '/bind/status') { const s = readJSON(P.bindStatus) || {}; return J(200, { ...s, credentials_present: true, gateway_ws: state.ws }); }
    if (u.pathname === '/pending') return J(200, readJSONL(P.inbox).filter(x => x.status === 'pending'));
    if (u.pathname === '/outbox') { const st = u.searchParams.get('status'); return J(200, readJSONL(P.outbox).filter(x => !st || x.status === st)); }
    if (req.method === 'POST' && u.pathname === '/reply') {
      const b = await body(req);
      const inb = b.id ? readJSONL(P.inbox).find(x => x.id === b.id) : null;
      if (b.id && !inb) return J(404, { ok: false, error: `收件箱里没有 id=${b.id}` });
      if (!inb && !(b.scope && b.target)) return J(400, { ok: false, error: '需要 id（收件箱消息）或 scope+target' });
      const scope = inb ? inb.scope : b.scope, target = inb ? inb.target : b.target;
      if (!['c2c', 'group', 'channel', 'dm'].includes(scope)) return J(400, { ok: false, error: 'scope 只能是 c2c / group / channel / dm' });
      const files = Array.isArray(b.files) ? b.files : b.files ? [b.files] : [];
      if (!b.content && !files.length) return J(400, { ok: false, error: '缺 content 或 files' });
      if (files.length && (scope === 'channel' || scope === 'dm')) return J(400, { ok: false, error: '频道/频道私信目前只支持发文字，不支持 files' });
      if (files.length > 10) return J(400, { ok: false, error: '一次最多 10 个文件' });
      const specs = [];
      for (const f of files) {
        try { const sp = await media.resolveFileSpec(f); if (f.caption) sp.caption = String(f.caption); specs.push(sp); }
        catch (e) { return J(400, { ok: false, error: e.message, file: f.path || f.url || null, queued: [] }); }
      }
      const items = enqueue({ scope, target, content: b.content, files: specs, msg_id: inb?.id, msg_ts: inb?.msg_ts, inbox_id: inb?.id, markdown: b.markdown, quote: b.quote });
      if (inb && b.done) updateInbox(inb.id, { status: 'done', done_at: new Date().toISOString() });
      return J(200, { ok: true, queued: items.map(x => x.id), files: specs.map(x => ({ name: x.name, type: x.type, size: x.size, notes: x.notes.length ? x.notes : undefined })) });
    }
    // 只上传不发送（srv_send_msg=false），用于自检 / 预检
    if (req.method === 'POST' && u.pathname === '/media/upload') {
      const b = await body(req);
      if (!['c2c', 'group'].includes(b.scope) || !b.target) return J(400, { ok: false, error: '需要 scope(c2c|group)+target' });
      const files = Array.isArray(b.files) ? b.files : [];
      const results = [];
      for (const f of files) {
        try {
          const sp = await media.resolveFileSpec(f);
          const t0 = Date.now(); const r = await media.uploadMedia(api, b.scope, b.target, sp, log, { forceChunked: !!f.force_chunked, noCache: !!f.no_cache });
          results.push({ ok: true, name: sp.name, type: sp.type, size: sp.size, via: r.via, file_info: !!r.file_info, file_info_len: r.file_info ? r.file_info.length : 0, ttl: r.ttl, ms: Date.now() - t0 });
        } catch (e) { results.push({ ok: false, file: f.path || f.url, error: e.message, code: e.code }); }
      }
      return J(200, { ok: results.every(x => x.ok), results });
    }
    // 正在输入（仅私聊，需 id，占一次被动回复）
    if (req.method === 'POST' && u.pathname === '/typing') {
      const b = await body(req); const inb = readJSONL(P.inbox).find(x => x.id === b.id);
      if (!inb || inb.scope !== 'c2c') return J(400, { ok: false, error: '需要私聊收件箱消息 id' });
      await api('POST', `/v2/users/${inb.target}/messages`, { msg_type: 6, input_notify: { input_type: 1, input_second: Math.min(60, Number(b.seconds) || 60) }, msg_seq: nextSeq(inb.id), msg_id: inb.id });
      return J(200, { ok: true });
    }
    // 撤回已发消息：{outbox_id}
    if (req.method === 'POST' && u.pathname === '/recall') {
      const b = await body(req); const it = readJSONL(P.outbox).find(x => x.id === b.outbox_id);
      if (!it || !it.sent_msg_id) return J(404, { ok: false, error: '找不到已发送的 outbox_id（或没有消息 id）' });
      const pth = it.scope === 'group' ? `/v2/groups/${it.target}/messages/${it.sent_msg_id}` : it.scope === 'c2c' ? `/v2/users/${it.target}/messages/${it.sent_msg_id}` : it.scope === 'channel' ? `/channels/${it.target}/messages/${it.sent_msg_id}?hidetip=true` : `/dms/${it.target}/messages/${it.sent_msg_id}?hidetip=true`;
      await api('DELETE', pth);
      writeJSONL(P.outbox, mergeOutbox({ ...it, recalled_at: new Date().toISOString() }));
      return J(200, { ok: true });
    }
    if (u.pathname === '/known') return J(200, inbound.listKnown());
    if (u.pathname === '/events') { const n = Number(u.searchParams.get('limit') || 50); return J(200, readJSONL(EVENTS_F).slice(-n)); }
    if (u.pathname === '/inbox') { const n = Number(u.searchParams.get('limit') || 20); const st = u.searchParams.get('status'); return J(200, readJSONL(P.inbox).filter(x => !st || x.status === st).slice(-n)); }
    if (u.pathname === '/ref') return J(200, inbound.refGet(u.searchParams.get('k')) || null);
    if (req.method === 'POST' && u.pathname === '/ack') { const b = await body(req); const it = updateInbox(b.id, { status: 'done', done_at: new Date().toISOString() }); return J(it ? 200 : 404, { ok: !!it }); }
    if (req.method === 'POST' && u.pathname === '/outbox/retry') {
      const b = await body(req); const all = readJSONL(P.outbox); let n = 0;
      for (const x of all) if (x.status === 'failed' && (!b.id || x.id === b.id)) { x.status = 'pending'; x.attempts = 0; x.next_at = Date.now(); x.force_active = true; n++; }
      writeJSONL(P.outbox, all); setImmediate(drain); return J(200, { ok: true, retried: n });
    }
    J(404, { ok: false, error: 'not found' });
  } catch (e) { J(500, { ok: false, error: e.message }); }
}).on('error', e => { log('本地接口启动失败', e.message); process.exit(3); }).listen(PORT, HOST, () => { log(`本地接口 http://${HOST}:${PORT}（${VERSION}，pid ${process.pid}）`); connect(); tokenTick(); }); // 先占端口再连 QQ：端口被占（已有实例）就直接退出，保证单实例

// 重启后续传未完成的附件下载
setTimeout(() => {
  for (const it of readJSONL(P.inbox)) if (it.attachments_ready === false && Array.isArray(it.attachments)) {
    const recs = it.attachments.filter(r => r.status === 'pending');
    if (!recs.length) { updateInbox(it.id, { attachments_ready: true }); continue; }
    inbound.downloadAll(recs, it.id).then(() => updateInbox(it.id, { attachments: it.attachments, attachments_ready: true })).catch(() => {});
  }
}, 2000);
process.on('unhandledRejection', e => { state.last_error = String(e?.message || e); log('unhandledRejection', state.last_error); });
process.on('SIGTERM', () => { cleanup(); hook.flush(); setTimeout(() => process.exit(0), 300); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
