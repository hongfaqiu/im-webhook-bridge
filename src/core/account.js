// 一个账号的运行时：账号锁 + 收件箱 + 发件队列 + webhook + 平台实例。
// 平台只负责协议；收件去重、自动回执、附件下载、webhook 推送、发件重试都在这里统一处理。
import path from 'node:path';
import { ensureDir, makeLogger } from '../util.js';
import { acquireLock } from './lock.js';
import { createInbox } from './inbox.js';
import { createOutbox } from './outbox.js';
import { createWebhook } from './webhook.js';
import { saveAttachment } from './attachments.js';

// 对外（HTTP / webhook）隐藏的内部字段：CDN 下载密钥等
export function publicItem(it) {
  if (!it) return it;
  const o = { ...it };
  if (Array.isArray(o.attachments)) o.attachments = o.attachments.map(a => { const { cdn, ...rest } = a; return rest; });
  return o;
}

export function createAccount({ cfg, acc, factory, fatal = () => {}, log: baseLog, downloadOpts = {} }) {
  const log = baseLog || makeLogger(acc.id);
  const dir = ensureDir(acc.dir);
  const state = { state: 'init', started_at: null, last_error: null };
  let lock = null, platform = null, outbox = null, credTimer = null, resumeTimer = null;
  const inbox = createInbox(dir);
  const webhook = createWebhook({ dirs: [dir, cfg.dataDir], failDir: dir, log, meta: { platform: acc.platform, account: acc.id }, ...(acc.webhook_opts || {}) });

  const runtime = {
    id: acc.id, platformName: acc.platform, dir, inbox, webhook, state,
    get platform() { return platform; }, get outbox() { return outbox; },
  };

  async function downloadAttachments(id) {
    const it = inbox.find(id);
    if (!it || !Array.isArray(it.attachments)) return;
    const recs = it.attachments;
    await Promise.all(recs.filter(r => r.status === 'pending').map(r =>
      saveAttachment(r, id, { root: path.join(dir, 'inbox-files'), sources: platform.attachmentSources(r), ...downloadOpts }).catch(e => { r.status = 'failed'; r.error = e.message; })));
    const done = inbox.update(id, { attachments: recs, attachments_ready: true });
    log('附件处理完', id.slice(-8), recs.map(r => `${r.kind}:${r.status}`).join(','));
    return done;
  }

  // 平台收到一条消息（native_id 是平台原始 id）→ 入收件箱；重复返回 null
  function onMessage(native) {
    const id = `${acc.id}:${native.native_id}`;
    if (inbox.has(id)) return null;
    const item = { id, platform: acc.platform, account: acc.id, ...native, auto_acked: false };
    inbox.append(item);
    log('收到消息', item.scope, item.status === 'observed' ? '(未@，仅记录)' : '', `附件${item.attachments?.length || 0}`);
    if (item.status === 'pending' && platform.autoAck) {
      outbox.enqueue({ scope: item.scope, target: item.target, content: platform.autoAck, reply_to: item.native_id, reply_ts: item.msg_ts, inbox_id: id });
      inbox.update(id, { auto_acked: true });
    }
    const wantHook = item.status === 'pending';
    if (item.attachments_ready === false) {
      downloadAttachments(id).then(it => { if (wantHook) webhook.push(it || item); })
        .catch(e => { log('附件下载异常', e.message); const it = inbox.update(id, { attachments_ready: true, attachments_error: e.message }); if (wantHook) webhook.push(it || item); });
    } else if (wantHook) webhook.push(item);
    return item;
  }

  function startPlatform() {
    try {
      platform.start();
      state.state = 'running'; state.started_at = new Date().toISOString(); state.last_error = null;
      outbox.start();
      // 重启后续传没下完的附件
      resumeTimer = setTimeout(() => { for (const it of inbox.all()) if (it.attachments_ready === false) downloadAttachments(it.id).catch(() => {}); }, 2000);
      resumeTimer.unref?.();
    } catch (e) { state.state = 'error'; state.last_error = e.message; log('启动失败', e.message); }
  }

  runtime.start = function start() {
    if (acc.enabled === false) { state.state = 'disabled'; return runtime; }
    lock = acquireLock(dir);
    platform = factory({ account: acc.id, dir, log, options: acc, onMessage, wakeOutbox: t => outbox.wake(t), fatal: msg => fatal(msg, acc.id) });
    outbox = createOutbox({ dir, account: acc.id, platform, log });
    if (!platform.hasCredentials()) {
      state.state = 'unbound';
      log(`还没绑定（运行 node cli.js bind ${acc.id}），绑定后会自动上线`);
      credTimer = setInterval(() => { if (platform.hasCredentials()) { clearInterval(credTimer); credTimer = null; log('检测到新凭证，上线'); startPlatform(); } }, 10000);
      credTimer.unref?.();
      return runtime;
    }
    startPlatform();
    return runtime;
  };

  runtime.stop = async function stop() {
    if (credTimer) clearInterval(credTimer);
    if (resumeTimer) clearTimeout(resumeTimer);
    outbox?.stop();
    try { await platform?.stop?.(); } catch {}
    await webhook.flush();
    lock?.release();
    state.state = 'stopped';
  };

  runtime.health = function health() {
    const ph = state.state === 'running' && platform ? platform.health() : {};
    return {
      id: acc.id, platform: acc.platform, state: state.state, ok: state.state === 'running' && !!ph.ok,
      ...ph, last_error: ph.last_error ?? state.last_error,
      pending_inbox: inbox.list({ status: 'pending' }).length,
      attachments_downloading: inbox.all().filter(x => x.attachments_ready === false).length,
      outbox: outbox ? outbox.counts() : null, sent: outbox ? outbox.stats.sent : 0,
      webhook: webhook.status(),
    };
  };
  return runtime;
}
