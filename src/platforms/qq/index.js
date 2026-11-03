// QQ 开放平台机器人：token 自动刷新 + WebSocket 网关（C2C 私聊 / 群 @ / 频道）+ 心跳看门狗 + 发送降级
// 协议参考 @tencent-connect/openclaw-qqbot 2.0.4。一个账号一个实例，状态都在 <account dir>/ 下。
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { readJSON, writeJSON, readJSONL, appendJSONL } from '../../util.js';
import { createInbound, attachmentSources } from './inbound.js';
import { createUploader, TYPE_LIMIT, HARD_MAX } from './upload.js';
import { bindQQ } from './bind.js';
import { kindLabel } from '../../core/attachments.js';

const INTENTS = (1 << 25) | (1 << 12) | (1 << 30); // GROUP_AND_C2C | DIRECT_MESSAGE | PUBLIC_GUILD_MESSAGES
const PASSIVE_WINDOW_MS = { c2c: 55 * 60 * 1000, group: 4.5 * 60 * 1000, channel: 4.5 * 60 * 1000, dm: 4.5 * 60 * 1000 };
const PERMANENT_CODES = new Set([11255]); // 用户/群不存在或已注销：不再重试
const MESSAGE_EVENTS = ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE'];
const LIFECYCLE = ['FRIEND_ADD', 'FRIEND_DEL', 'C2C_MSG_REJECT', 'C2C_MSG_RECEIVE', 'GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MSG_REJECT', 'GROUP_MSG_RECEIVE'];
const DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const WD_TICK = 5000;

export const SCOPES = ['c2c', 'group', 'channel', 'dm'];

export function msgPath(scope, target) {
  return scope === 'group' ? `/v2/groups/${target}/messages` : scope === 'channel' ? `/channels/${target}/messages` : scope === 'dm' ? `/dms/${target}/messages` : `/v2/users/${target}/messages`;
}

// 发送失败后的降级（纯函数，便于测试）：markdown → 纯文本 → 去引用 → 被动转主动 → c2c 主动加 wakeup；语音/视频上传失败 → 改按文件
export function qqOnSendError(it, e) {
  const passiveTried = it.reply_to && !it.force_active;
  if (it.kind === 'media' && it.stage === 'upload') {
    if (/文件不存在|ENOENT/.test(e.message)) return 'failed';
    if ((it.media.type === 'voice' || it.media.type === 'video') && !it.fallback_tried && (e.voiceFallback || (e.status >= 400 && e.status < 500))) {
      it.fallback_tried = true; it.media = { ...it.media, type: 'file', notes: [...(it.media.notes || []), `${it.media.type} 发送失败，改按文件发`] };
      it.file_info = null; it.attempts = Math.max(0, it.attempts - 1);
    }
  } else {
    if (it.kind === 'media' && it.attempts >= 2) it.file_info = null; // file_info 可能失效，下次重新上传
    if (it.markdown && !it.markdown_failed && e.code) it.markdown_failed = true;
    else if (it.quote && !it.quote_failed && e.code && passiveTried) it.quote_failed = true;
    else if (passiveTried) it.force_active = true;
    if (!passiveTried && it.scope === 'c2c' && !it.wakeup && it.attempts >= 2) it.wakeup = true;
  }
  if (PERMANENT_CODES.has(e.code)) return 'failed';
  return undefined;
}

export function createQQ(ctx) {
  const { dir, log, account } = ctx;
  const opt = ctx.options || {};
  const API = opt.api_base || process.env.QQBOT_BASE_URL || 'https://api.sgroup.qq.com';
  const TOKEN_URL = (opt.token_base || process.env.QQBOT_TOKEN_BASE_URL || 'https://bots.qq.com') + '/app/getAppAccessToken';
  const HARD_EXTRA_MS = Number(opt.hard_watchdog_extra_ms || process.env.QQBOT_HARD_WATCHDOG_EXTRA_MS || 60000);
  const AUTO_ACK = opt.auto_ack !== undefined ? opt.auto_ack : (process.env.QQBOT_AUTO_ACK ?? '收到，正在处理…');
  const F = { creds: path.join(dir, 'credentials.json'), session: path.join(dir, 'session.json'), events: path.join(dir, 'events.jsonl') };
  const inbound = createInbound(dir);
  let creds = null, upload = null;

  const state = { ws: 'init', session_id: null, seq: null, bot: null, last_hello: null, last_ready: null, last_heartbeat_sent: null, last_ack: null,
    last_event: null, reconnects: 0, resume_failures: 0, last_error: null, token_expires_at: null, received: 0,
    conn_started_at: null, clock_jumps: 0, last_clock_jump: null };
  const timers = new Set();
  const every = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); timers.add(t); return t; };
  let stopped = true;

  function saveSession() { try { writeJSON(F.session, { session_id: state.session_id, seq: state.seq, bot: state.bot }, 0o600); } catch {} }

  // ---------- token ----------
  let token = null, tokenExp = 0, tokenPromise = null, tokenTimer = null;
  async function fetchToken() {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: creds.appId, clientSecret: creds.appSecret }), signal: ctl.signal });
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
  // 独立定时器：每 30s 按墙钟检查（休眠醒来第一次 tick 就刷新），另在到期前 5 分钟精确刷新一次
  function tokenTick() {
    if (stopped) return;
    getToken().then(() => {
      if (tokenTimer) clearTimeout(tokenTimer);
      const at = Math.max(30 * 1000, tokenExp - Date.now() - 5 * 60 * 1000);
      tokenTimer = setTimeout(tokenTick, Math.min(at, 2 ** 31 - 1)); tokenTimer.unref?.();
    }).catch(e => { state.last_error = 'token: ' + e.message; log(state.last_error); });
  }

  async function api(method, p, body, o = {}) {
    for (let i = 0; i < 2; i++) {
      const tk = await getToken(i > 0);
      const ms = o.timeoutMs || 20000;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
      try {
        let r;
        try { r = await fetch(API + p, { method, signal: ctl.signal, headers: { Authorization: `QQBot ${tk}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
        catch (e) { if (e.name === 'AbortError') { const x = new Error(`请求超时（${Math.round(ms / 1000)}s）${p.replace(/\/[A-F0-9]{32}\b/g, '/…')}`); x.timeout = true; throw x; } throw e; }
        const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
        if (r.status === 401 && i === 0) continue;
        const biz = j.code ?? j.err_code;
        if (!r.ok || (biz && biz !== 0 && !j.id && !j.file_info && !j.upload_id)) { const e = new Error(`API ${r.status} code=${biz ?? ''} ${j.message ?? text.slice(0, 200)}`); e.code = biz; e.status = r.status; throw e; }
        return j;
      } finally { clearTimeout(t); }
    }
  }

  // msg_seq：同一 msg_id 下递增，起点随机（重启后不撞号）
  const seqCounter = new Map();
  function nextSeq(msgId) { let n = seqCounter.get(msgId); n = n == null ? (Date.now() % 1e8 ^ crypto.randomInt(65536)) % 60000 + 1 : n + 1; seqCounter.set(msgId, n); return n % 65536 || 1; }

  async function send(it) {
    const passiveOk = it.reply_to && !it.force_active && it.reply_ts && (Date.now() - it.reply_ts) < (PASSIVE_WINDOW_MS[it.scope] || PASSIVE_WINDOW_MS.group);
    const guild = it.scope === 'channel' || it.scope === 'dm';
    let body;
    if (it.kind === 'media') {
      if (!it.file_info || (it.file_info_exp && it.file_info_exp < Date.now())) {
        it.stage = 'upload';
        const up = await upload(it.scope, it.target, it.media);
        it.file_info = up.file_info; it.file_info_exp = up.ttl > 0 ? Date.now() + (up.ttl - 120) * 1000 : Date.now() + 30 * 60 * 1000; it.upload_via = up.via;
      }
      body = { msg_type: 7, media: { file_info: it.file_info } };
      if (it.media.caption) body.content = it.media.caption;
    } else if (guild) body = { content: it.content };
    else if (it.markdown && !it.markdown_failed) body = { msg_type: 2, markdown: { content: it.content } };
    else body = { content: it.content, msg_type: 0 };
    it.stage = 'send';
    if (passiveOk) { body.msg_id = it.reply_to; if (!guild) body.msg_seq = nextSeq(it.reply_to); if (it.quote && !it.quote_failed) body.message_reference = { message_id: it.reply_to }; }
    else if (!guild) { body.msg_seq = nextSeq('active:' + it.target); if (it.scope === 'c2c' && it.wakeup) body.is_wakeup = true; }
    const r = await api('POST', msgPath(it.scope, it.target), body);
    it.mode = passiveOk ? 'passive' : 'active';
    const refIdx = r?.ext_info?.ref_idx;
    if (refIdx) inbound.refSet(refIdx, { messageId: r.id, content: it.kind === 'media' ? `[${kindLabel(it.media.type)}:${it.media.name}]` : it.content, senderId: creds.appId, senderName: state.bot?.username, timestamp: new Date().toISOString(), isBot: true, scope: it.scope });
    if (it.kind === 'media') log('已发送', it.media.type, it.media.name, it.upload_via || '', it.mode);
    return { sent_msg_id: r?.id || null };
  }

  // ---------- WebSocket ----------
  let ws = null, hbTimer = null, hbInterval = 41250, reconnectTimer = null, attempts = 0, connecting = false, awakeSinceHealthy = 0, connGen = 0, lastTick = Date.now();
  function stopHeartbeat() { if (hbTimer) clearInterval(hbTimer); hbTimer = null; }
  function cleanup() { stopHeartbeat(); if (ws) { const w = ws; ws = null; try { w.removeAllListeners(); w.on('error', () => {}); w.terminate(); } catch {} } }
  function wsSend(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function heartbeatOnce() {
    if (!ws || ws.readyState !== WebSocket.OPEN) { log('心跳时发现 WS 未打开，重连'); forceReconnect(1000); return; }
    wsSend({ op: 1, d: state.seq }); state.last_heartbeat_sent = Date.now();
  }
  function startHeartbeat(immediate) { stopHeartbeat(); hbTimer = setInterval(heartbeatOnce, hbInterval); if (immediate) heartbeatOnce(); }
  function forceReconnect(delay) { if (state.ws === 'resuming') state.resume_failures++; connGen++; cleanup(); connecting = false; schedule(delay); }
  function markHealthy() { state.last_ack = Date.now(); awakeSinceHealthy = 0; }
  function schedule(delay) {
    if (reconnectTimer || stopped) return;
    const d = delay ?? DELAYS[Math.min(attempts, DELAYS.length - 1)]; attempts++; state.reconnects++;
    state.ws = 'reconnecting'; log(`${d}ms 后重连（第 ${attempts} 次）`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, d);
  }
  async function connect() {
    if (connecting || stopped) return; connecting = true; cleanup(); state.ws = 'connecting'; state.conn_started_at = Date.now();
    const my = ++connGen;
    try {
      const g = await api('GET', '/gateway');
      const tk = await getToken();
      if (my !== connGen || stopped) return;
      const w = new WebSocket(g.url, { handshakeTimeout: 20000 }); ws = w;
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
  function onPayload(p, tk) {
    if (p.s != null) state.seq = p.s;
    switch (p.op) {
      case 10:
        state.last_hello = Date.now(); state.last_ack = Date.now(); state.last_heartbeat_sent = null;
        hbInterval = p.d?.heartbeat_interval || 41250;
        if (state.session_id && state.seq != null && state.resume_failures < 2) { state.ws = 'resuming'; wsSend({ op: 6, d: { token: `QQBot ${tk}`, session_id: state.session_id, seq: state.seq } }); }
        else { state.ws = 'identifying'; wsSend({ op: 2, d: { token: `QQBot ${tk}`, intents: INTENTS, shard: [0, 1] } }); }
        startHeartbeat(false); break;
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
    if (t === 'RESUMED') {
      if (!state.bot) api('GET', '/users/@me').then(u => { state.bot = { id: u.id, username: u.username }; saveSession(); }).catch(() => {});
      state.ws = 'ready'; state.last_ready = Date.now(); state.resume_failures = 0; markHealthy(); attempts = 0; startHeartbeat(true); log('RESUMED'); saveSession(); return;
    }
    saveSession();
    if (MESSAGE_EVENTS.includes(t)) return onMessage(t, d);
    if (LIFECYCLE.includes(t)) return onLifecycle(t, d);
  }
  function onLifecycle(t, d) {
    const ev = { type: t, at: new Date().toISOString(), openid: d.openid || d.user_openid || null, group_openid: d.group_openid || null, op_member_openid: d.op_member_openid || null, event_id: d.id || null, timestamp: d.timestamp || null };
    try { appendJSONL(F.events, ev); } catch {}
    if (t.startsWith('FRIEND') || t.startsWith('C2C')) inbound.touchKnown('c2c', ev.openid, { friend: t === 'FRIEND_DEL' ? false : t === 'FRIEND_ADD' ? true : undefined, proactive_allowed: t === 'C2C_MSG_REJECT' ? false : t === 'C2C_MSG_RECEIVE' ? true : undefined }, false);
    else inbound.touchKnown('group', ev.group_openid, { in_group: t === 'GROUP_DEL_ROBOT' ? false : t === 'GROUP_ADD_ROBOT' ? true : undefined, proactive_allowed: t === 'GROUP_MSG_REJECT' ? false : t === 'GROUP_MSG_RECEIVE' ? true : undefined }, false);
    log('事件', t);
  }
  function onMessage(t, d) {
    const item = inbound.buildInboxItem(t, d, { botIds: [state.bot?.id, creds.appId] });
    if (!item) return;
    const stored = ctx.onMessage(item);
    if (!stored) return; // 重复
    state.received++;
    inbound.rememberInbound(item);
    if (item.scope === 'c2c') inbound.touchKnown('c2c', item.target);
    else if (item.scope === 'group') inbound.touchKnown('group', item.target, { last_member: item.author });
    else inbound.touchKnown(item.scope, item.target, { guild_id: item.guild_id });
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
  // 软：ACK 超过 2.5 个心跳周期 → 重连；连接/握手卡 60s → 重连；墙钟跳变（休眠醒来）→ 立刻刷 token、补心跳。
  // 硬：醒着的时间累计超过 3 个心跳周期 + 60s 仍无 ACK/READY/RESUMED → ctx.fatal()（默认整个进程退出码 1，交给 launchd/supervise 拉起）。
  const hardLimitMs = () => hbInterval * 3 + HARD_EXTRA_MS;
  const ackStale = () => state.ws === 'ready' && state.last_ack != null && (Date.now() - state.last_ack) > hbInterval * 2.5;
  function watchdogTick(fromHealth) {
    if (stopped) return;
    const now = Date.now(), gap = now - lastTick;
    const jumped = !fromHealth && gap > 3 * WD_TICK;
    if (!fromHealth) { lastTick = now; awakeSinceHealthy += jumped ? WD_TICK : Math.min(Math.max(gap, 0), 2 * WD_TICK); }
    if (jumped) {
      state.clock_jumps++; state.last_clock_jump = new Date().toISOString();
      log(`墙钟跳了 ${Math.round(gap / 1000)}s（机器休眠/冻结后醒来），立刻检查 token 和连接`);
      tokenTick(); if (ws && state.ws === 'ready') heartbeatOnce();
    }
    if (awakeSinceHealthy > hardLimitMs()) { ctx.fatal(`QQ 看门狗：已 ${Math.round(awakeSinceHealthy / 1000)}s 没有 ACK/READY/RESUMED（上限 ${Math.round(hardLimitMs() / 1000)}s）`); return; }
    if (connecting && state.conn_started_at && now - state.conn_started_at > 60000) { log('连接过程卡住超过 60s，强制重连'); forceReconnect(1000); return; }
    if (!ws || connecting) { if (!ws && !reconnectTimer && !connecting) schedule(); return; }
    if (ackStale()) { log('心跳 ACK 陈旧，强制重连'); forceReconnect(1000); return; }
    const since = Math.max(state.last_hello || 0, state.conn_started_at || 0);
    if (state.ws !== 'ready' && since && now - since > 60000) { log('握手卡住，强制重连'); forceReconnect(1000); return; }
    if (state.ws === 'ready' && !hbTimer) { log('心跳定时器不在，重新启动'); startHeartbeat(true); }
  }

  function hasCredentials() { const c = readJSON(F.creds); return !!(c && c.appId && c.appSecret); }

  return {
    name: 'qq', scopes: SCOPES, textLimit: 1800, autoAck: AUTO_ACK || null,
    sendLimits: { hardMax: HARD_MAX, perType: TYPE_LIMIT },
    hasCredentials,
    start() {
      creds = readJSON(F.creds);
      if (!creds?.appId || !creds?.appSecret) throw new Error('没有凭证');
      const sess = readJSON(F.session) || {};
      if (sess.session_id) { state.session_id = sess.session_id; state.seq = sess.seq ?? null; }
      if (sess.bot) state.bot = sess.bot;
      upload = createUploader(dir, api, log);
      stopped = false; lastTick = Date.now(); awakeSinceHealthy = 0;
      every(tokenTick, 30 * 1000);
      every(() => { try { watchdogTick(false); } catch (e) { log('watchdog 异常', e.message); } }, WD_TICK);
      connect(); tokenTick();
    },
    stop() {
      stopped = true; for (const t of timers) clearInterval(t); timers.clear();
      if (tokenTimer) clearTimeout(tokenTimer); if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null;
      connGen++; cleanup(); state.ws = 'stopped';
    },
    health() {
      const stale = ackStale(), tokenValid = !!token && Date.now() < tokenExp;
      if (!stopped && (stale || !tokenValid)) setImmediate(() => { try { if (!tokenValid) tokenTick(); watchdogTick(true); } catch {} });
      return { ok: state.ws === 'ready' && !stale && tokenValid, ws: state.ws, stale, app_id: creds?.appId || null, bot: state.bot,
        last_ack_age_s: state.last_ack ? Math.round((Date.now() - state.last_ack) / 1000) : null, reconnects: state.reconnects,
        heartbeat_running: !!hbTimer, heartbeat_interval_s: Math.round(hbInterval / 1000),
        watchdog_unhealthy_s: Math.round(awakeSinceHealthy / 1000), watchdog_limit_s: Math.round(hardLimitMs() / 1000), clock_jumps: state.clock_jumps,
        token_expires_at: state.token_expires_at, token_valid: tokenValid, received: state.received, last_error: state.last_error };
    },
    send,
    onSendError: qqOnSendError,
    attachmentSources: rec => attachmentSources(rec, { allowPrivate: !!opt.allow_private_downloads }),
    validateReply({ scope, files }) {
      if (files.length && (scope === 'channel' || scope === 'dm')) return '频道/频道私信目前只支持发文字，不支持 files';
      return null;
    },
    async typing(inb, seconds) {
      if (inb.scope !== 'c2c') throw new Error('只有 QQ 私聊支持“正在输入”');
      await api('POST', `/v2/users/${inb.target}/messages`, { msg_type: 6, input_notify: { input_type: 1, input_second: Math.min(60, Number(seconds) || 60) }, msg_seq: nextSeq(inb.native_id), msg_id: inb.native_id });
    },
    async recall(it) {
      const id = it.sent_msg_id;
      const p = it.scope === 'group' ? `/v2/groups/${it.target}/messages/${id}` : it.scope === 'c2c' ? `/v2/users/${it.target}/messages/${id}` : it.scope === 'channel' ? `/channels/${it.target}/messages/${id}?hidetip=true` : `/dms/${it.target}/messages/${id}?hidetip=true`;
      await api('DELETE', p);
    },
    known: () => inbound.listKnown(),
    events: n => readJSONL(F.events).slice(-n),
    ref: k => inbound.refGet(k),
    bind: o => bindQQ({ dir, log, ...o }),
    _test: { inbound, onPayload, state },
  };
}
