// 微信（iLink Bot）账号：长轮询收消息 + context_token 路由回复 + CDN 媒体收发。状态都在 <account dir>/ 下：
//   credentials.json（token 等，600）、sync_buf（getupdates 游标）、contexts.json（每个联系人最新的 context_token）
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON } from '../../util.js';
import { createIlink, DEFAULT_BASE, DEFAULT_CDN } from './ilink.js';
import { buildInboxItem, attachmentSources } from './inbound.js';
import { textItem, uploadToCdn, mediaItem, loadSpec, HARD_MAX, TYPE_LIMIT } from './send.js';
import { bindWechat } from './bind.js';

const SESSION_EXPIRED = -14;
const CONTEXT_EXPIRED = -2;

// 发送失败：没有上下文 / ret=-2（上下文过期）→ 等对方再发消息；文件不存在 → 失败；其余按退避重试
export function wechatOnSendError(it, e) {
  if (e.noContext || e.ret === CONTEXT_EXPIRED || e.errcode === CONTEXT_EXPIRED) return 'waiting';
  if (/文件不存在|ENOENT/.test(e.message)) return 'failed';
  return undefined;
}

export function createWechat(ctx) {
  const { dir, log } = ctx;
  const opt = ctx.options || {};
  const F = { creds: path.join(dir, 'credentials.json'), buf: path.join(dir, 'sync_buf'), ctx: path.join(dir, 'contexts.json') };
  const state = { poll: 'init', session: 'unknown', received: 0, last_poll_at: null, last_ok_at: null, last_error: null, failures: 0, paused_until: null };
  let ilink = null, stopped = true, abort = null, loopP = null, pollTimeout = Number(opt.poll_timeout_ms || 35000);

  const contexts = () => readJSON(F.ctx, {});
  function saveContext(from, token) {
    const c = contexts(); c[from] = { context_token: token, at: new Date().toISOString() }; c.__last_from = from;
    writeJSON(F.ctx, c, 0o600);
  }
  const readBuf = () => { try { return fs.readFileSync(F.buf, 'utf8').trim(); } catch { return ''; } };
  const writeBuf = b => { try { fs.writeFileSync(F.buf, b, { mode: 0o600 }); fs.chmodSync(F.buf, 0o600); } catch {} };

  function sleepAbortable(ms) {
    return new Promise(r => { const t = setTimeout(r, ms); abort?.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  }

  function handle(msg) {
    if (msg?.message_type === 2) return;
    const from = msg?.from_user_id;
    if (from && msg.context_token) saveContext(from, msg.context_token);
    const item = buildInboxItem(msg);
    if (item) { const stored = ctx.onMessage(item); if (stored) state.received++; }
    if (from && msg.context_token) ctx.wakeOutbox(from); // 有了新上下文：之前等待的回复可以发了
  }

  async function loop() {
    let buf = readBuf();
    await ilink.notify('start');
    while (!stopped) {
      state.poll = 'polling'; state.last_poll_at = new Date().toISOString();
      try {
        const resp = await ilink.getUpdates(buf, pollTimeout, abort.signal);
        const code = resp.ret ?? resp.errcode ?? 0;
        if (code === SESSION_EXPIRED) {
          state.session = 'expired'; state.last_error = 'iLink 会话过期（-14），10 分钟后再试；长期如此需要重新 bind';
          state.paused_until = new Date(Date.now() + 600000).toISOString(); log(state.last_error);
          await sleepAbortable(10 * 60 * 1000); state.paused_until = null; continue;
        }
        if (code !== 0) throw new Error(`getupdates ret=${code} ${resp.errmsg || ''}`.trim());
        state.session = 'ok'; state.failures = 0; state.last_ok_at = new Date().toISOString(); state.last_error = null;
        if (resp.longpolling_timeout_ms) pollTimeout = Number(resp.longpolling_timeout_ms);
        for (const m of resp.msgs || []) { try { handle(m); } catch (e) { log('处理消息出错', e.message); } }
        if (resp.get_updates_buf && resp.get_updates_buf !== buf) { buf = resp.get_updates_buf; writeBuf(buf); }
      } catch (e) {
        if (stopped) break;
        if (e.name === 'AbortError') continue; // 长轮询超时 = 没有新消息
        state.failures++; state.last_error = e.message; state.poll = 'backoff';
        log('getupdates 失败', e.message);
        await sleepAbortable(state.failures >= 3 ? 30000 : 2000);
      }
    }
    state.poll = 'stopped';
  }

  async function send(it) {
    const c = contexts()[it.target];
    if (!c?.context_token) { const e = new Error('还没有这个联系人的 context_token（需要对方先发一条消息）'); e.noContext = true; throw e; }
    let item;
    if (it.kind === 'media') {
      it.stage = 'upload';
      const type = it.media.type === 'voice' ? 'file' : it.media.type;
      const buf = await loadSpec(it.media, path.join(dir, 'tmp'));
      const up = await uploadToCdn(ilink, it.target, buf, type);
      item = mediaItem(type, up, it.media.name);
      if (it.media.caption && !it.caption_sent) { it.stage = 'send'; await ilink.sendMessage(it.target, textItem(it.media.caption), c.context_token); it.caption_sent = true; }
    } else item = textItem(it.content);
    it.stage = 'send';
    await ilink.sendMessage(it.target, item, c.context_token);
    it.mode = 'context';
    return {};
  }

  const hasCredentials = () => { const c = readJSON(F.creds); return !!(c && c.token); };

  return {
    name: 'wechat', scopes: ['c2c'], textLimit: Number(opt.text_limit || 2000), autoAck: opt.auto_ack || null,
    sendLimits: { hardMax: HARD_MAX, perType: TYPE_LIMIT },
    hasCredentials,
    start() {
      const cr = readJSON(F.creds);
      if (!cr?.token) throw new Error('没有凭证');
      ilink = createIlink({ baseUrl: opt.base_url || cr.baseUrl || DEFAULT_BASE, cdnBase: opt.cdn_base || DEFAULT_CDN, token: cr.token, routeTag: opt.route_tag || null });
      stopped = false; abort = new AbortController();
      fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true, mode: 0o700 });
      loopP = loop().catch(e => { state.last_error = e.message; log('轮询循环退出', e.message); });
    },
    async stop() {
      stopped = true; abort?.abort();
      if (ilink) await ilink.notify('stop');
      await loopP;
    },
    health() {
      const cr = readJSON(F.creds) || {};
      const c = contexts(); const contactsWithContext = Object.keys(c).filter(k => k !== '__last_from').length;
      return { ok: !stopped && state.session !== 'expired' && state.failures < 3, poll: state.poll, session: state.session, bot_id: cr.accountId || null,
        received: state.received, last_ok_at: state.last_ok_at, failures: state.failures, paused_until: state.paused_until,
        contacts_with_context: contactsWithContext, last_error: state.last_error };
    },
    send,
    onSendError: wechatOnSendError,
    attachmentSources: rec => attachmentSources(rec, ilink || createIlink({ cdnBase: opt.cdn_base || DEFAULT_CDN })),
    validateReply() { return null; },
    bind: o => bindWechat({ dir, log, baseUrl: opt.base_url || DEFAULT_BASE, ...o }),
    _test: { handle, state },
  };
}
