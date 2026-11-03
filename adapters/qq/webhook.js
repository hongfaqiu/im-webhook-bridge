'use strict';
// 入站消息 → 任意 Webhook（例如 AI Agent / 自动化平台，实现秒回）。
// 配置：data/webhook_url、data/webhook_key（都应为 600）。每次推送前重新读取，改文件无需重启。
// 两个文件缺一个就不推（巡检例程照常兜底）。日志里只出现 URL 的主机名，绝不出现 key 或完整 URL。
// 防抖：最后一条到达后等 DEBOUNCE_MS 再推，最长攒 MAX_WAIT_MS；一次 POST 合并多条：
//   {source:"qqbot", batch:true, count, messages:[{id,scope,target,author,content,attachments:[文件名],received_at}], sent_at}
// 失败重试（网络错误 / 408 / 429 / 5xx），次数用完写 data/webhook-failed.jsonl；任何异常都不抛给网关。
const fs = require('fs');
const path = require('path');

function create(opts = {}) {
  const dir = opts.dataDir;
  const log = opts.log || (() => {});
  const DEBOUNCE_MS = Number(opts.debounceMs ?? process.env.QQBOT_WEBHOOK_DEBOUNCE_MS ?? 4000);
  const MAX_WAIT_MS = Number(opts.maxWaitMs ?? process.env.QQBOT_WEBHOOK_MAX_WAIT_MS ?? 15000);
  const RETRY_DELAYS = opts.retryDelays || [2000, 5000, 15000, 30000];
  const TIMEOUT_MS = Number(opts.timeoutMs ?? 15000);
  const urlF = path.join(dir, 'webhook_url'), keyF = path.join(dir, 'webhook_key'), failF = path.join(dir, 'webhook-failed.jsonl');
  const st = { configured: false, pushed: 0, failed: 0, last_push_at: null, last_status: null, last_error: null, queued: 0 };
  let queue = [], timer = null, firstAt = 0, chain = Promise.resolve();

  function readCfg() {
    try {
      if (!fs.existsSync(urlF) || !fs.existsSync(keyF)) return null;
      for (const f of [urlF, keyF]) { const m = fs.statSync(f).mode & 0o777; if (m & 0o077) { try { fs.chmodSync(f, 0o600); log('webhook 配置文件权限过宽，已改为 600:', path.basename(f)); } catch {} } }
      const url = fs.readFileSync(urlF, 'utf8').trim(), key = fs.readFileSync(keyF, 'utf8').trim();
      if (!/^https?:\/\//i.test(url) || !key) return null;
      return { url, key };
    } catch { return null; }
  }
  function host(url) { try { return new URL(url).host; } catch { return '?'; } }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function scrub(s, cfg) { s = String(s); if (cfg) { s = s.split(cfg.key).join('***'); s = s.split(cfg.url).join('<webhook>'); } return s.slice(0, 200); }

  async function post(cfg, payload) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(cfg.url, { method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}`, 'X-Inbound-Id': payload.messages.map(m => m.id).join(',').slice(0, 900) },
        body: JSON.stringify(payload) });
      try { await r.arrayBuffer(); } catch {}
      return r.status;
    } finally { clearTimeout(t); }
  }

  async function send(batch) {
    const cfg = readCfg(); st.configured = !!cfg;
    if (!cfg) { log(`webhook 未配置（缺 data/webhook_url 或 data/webhook_key），${batch.length} 条留给巡检`); return; }
    const payload = { source: 'qqbot', batch: true, count: batch.length, messages: batch, sent_at: new Date().toISOString() };
    for (let i = 0; i <= RETRY_DELAYS.length; i++) {
      let status = null, err = null;
      try { status = await post(cfg, payload); } catch (e) { err = e.name === 'AbortError' ? `超时 ${TIMEOUT_MS / 1000}s` : (e.cause?.code || e.message); }
      if (status && status < 300) {
        st.pushed += batch.length; st.last_push_at = new Date().toISOString(); st.last_status = status; st.last_error = null;
        log(`webhook 已推送 ${batch.length} 条 → ${host(cfg.url)} HTTP ${status}${i ? `（第 ${i + 1} 次）` : ''}`); return;
      }
      st.last_status = status; st.last_error = scrub(err || `HTTP ${status}`, cfg);
      const retryable = !status || status === 408 || status === 429 || status >= 500;
      log(`webhook 推送失败 → ${host(cfg.url)} ${st.last_error}（第 ${i + 1} 次${retryable && i < RETRY_DELAYS.length ? '，稍后重试' : '，放弃'}）`);
      if (!retryable || i === RETRY_DELAYS.length) break;
      await sleep(RETRY_DELAYS[i]);
    }
    st.failed += batch.length;
    try { fs.appendFileSync(failF, JSON.stringify({ at: new Date().toISOString(), status: st.last_status, error: st.last_error, ids: batch.map(m => m.id) }) + '\n', { mode: 0o600 }); } catch {}
  }

  function flush() {
    if (timer) clearTimeout(timer); timer = null; firstAt = 0;
    const batch = queue; queue = []; st.queued = 0;
    if (!batch.length) return chain;
    chain = chain.then(() => send(batch)).catch(e => { log('webhook 内部错误', scrub(e.message)); });
    return chain;
  }
  function push(item) {
    try {
      const msg = {
        id: item.id, scope: item.scope, target: item.target, author: item.author ?? null, content: item.content ?? '',
        attachments: (item.attachments || []).map(a => a.filename || (a.local_path ? path.basename(a.local_path) : a.kind)).filter(Boolean),
        received_at: item.received_at || (item.msg_ts ? new Date(item.msg_ts).toISOString() : new Date().toISOString()),
      };
      if (queue.some(m => m.id === msg.id)) return;
      queue.push(msg); st.queued = queue.length;
      if (!firstAt) firstAt = Date.now();
      if (timer) clearTimeout(timer);
      const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - Date.now()));
      timer = setTimeout(flush, wait);
    } catch (e) { log('webhook 入队失败', e.message); }
  }
  function status() { st.configured = !!readCfg(); return { ...st }; }
  return { push, flush, status, _idle: () => chain };
}
module.exports = { create };
