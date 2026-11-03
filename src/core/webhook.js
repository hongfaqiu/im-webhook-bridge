// 入站消息 → 任意 Webhook（AI Agent / 自动化平台，实现秒回）。
// 配置：<dir>/webhook_url、<dir>/webhook_key（600）。dirs 按顺序找第一个两样都齐的目录
//   （账号目录 data/<account>/ 优先，其次全局 data/），每次推送前重新读取，改文件无需重启。
// 都没有就不推（下游轮询 /pending 兜底）。日志只出现 URL 主机名，绝不出现 key 或完整 URL。
// 防抖：最后一条到达后等 debounceMs 再推，最长攒 maxWaitMs；一次 POST 合并多条（载荷格式见 README）。
// 失败重试（网络错误 / 408 / 429 / 5xx），次数用完写 <failDir>/webhook-failed.jsonl；任何异常都不抛出。
import fs from 'node:fs';
import path from 'node:path';

export const WEBHOOK_SOURCE = 'im-webhook-bridge';

// 推给下游的精简字段（附件只给文件名，完整路径用 GET /pending 或 /inbox 取）
export function webhookMessage(item) {
  return {
    id: item.id, platform: item.platform, account: item.account,
    scope: item.scope, target: item.target, author: item.author ?? null, content: item.content ?? '',
    attachments: (item.attachments || []).map(a => a.filename || (a.local_path ? path.basename(a.local_path) : a.kind)).filter(Boolean),
    received_at: item.received_at || (item.msg_ts ? new Date(item.msg_ts).toISOString() : new Date().toISOString()),
  };
}

export function createWebhook(opts = {}) {
  const dirs = opts.dirs || [opts.dataDir];
  const failDir = opts.failDir || dirs[0];
  const log = opts.log || (() => {});
  const DEBOUNCE_MS = Number(opts.debounceMs ?? process.env.IMWB_WEBHOOK_DEBOUNCE_MS ?? 4000);
  const MAX_WAIT_MS = Number(opts.maxWaitMs ?? process.env.IMWB_WEBHOOK_MAX_WAIT_MS ?? 15000);
  const RETRY_DELAYS = opts.retryDelays || [2000, 5000, 15000, 30000];
  const TIMEOUT_MS = Number(opts.timeoutMs ?? 15000);
  const meta = opts.meta || {};
  const failF = path.join(failDir, 'webhook-failed.jsonl');
  const st = { configured: false, source: null, pushed: 0, failed: 0, last_push_at: null, last_status: null, last_error: null, queued: 0 };
  let queue = [], timer = null, firstAt = 0, chain = Promise.resolve();

  function readCfg() {
    for (const dir of dirs) {
      if (!dir) continue;
      const urlF = path.join(dir, 'webhook_url'), keyF = path.join(dir, 'webhook_key');
      try {
        if (!fs.existsSync(urlF) || !fs.existsSync(keyF)) continue;
        for (const f of [urlF, keyF]) {
          const m = fs.statSync(f).mode & 0o777;
          if (m & 0o077) { try { fs.chmodSync(f, 0o600); log('webhook 配置文件权限过宽，已改为 600:', path.basename(f)); } catch {} }
        }
        const url = fs.readFileSync(urlF, 'utf8').trim(), key = fs.readFileSync(keyF, 'utf8').trim();
        if (!/^https?:\/\//i.test(url) || !key) continue;
        return { url, key, dir };
      } catch {}
    }
    return null;
  }
  const host = url => { try { return new URL(url).host; } catch { return '?'; } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function scrub(s, cfg) { s = String(s); if (cfg) { s = s.split(cfg.key).join('***'); s = s.split(cfg.url).join('<webhook>'); } return s.slice(0, 200); }

  async function post(cfg, payload) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(cfg.url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}`, 'X-Inbound-Id': payload.messages.map(m => m.id).join(',').slice(0, 900) },
        body: JSON.stringify(payload),
      });
      try { await r.arrayBuffer(); } catch {}
      return r.status;
    } finally { clearTimeout(t); }
  }

  async function send(batch) {
    const cfg = readCfg(); st.configured = !!cfg;
    if (!cfg) { log(`webhook 未配置（缺 webhook_url 或 webhook_key），${batch.length} 条留给 /pending 轮询`); return; }
    const payload = { source: WEBHOOK_SOURCE, ...meta, batch: true, count: batch.length, messages: batch, sent_at: new Date().toISOString() };
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
      const msg = webhookMessage(item);
      if (queue.some(m => m.id === msg.id)) return;
      queue.push(msg); st.queued = queue.length;
      if (!firstAt) firstAt = Date.now();
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, Math.max(0, Math.min(DEBOUNCE_MS, firstAt + MAX_WAIT_MS - Date.now())));
    } catch (e) { log('webhook 入队失败', e.message); }
  }
  function status() {
    const cfg = readCfg(); st.configured = !!cfg;
    st.source = cfg ? (cfg.dir === dirs[0] ? 'account' : 'global') : null;
    return { ...st };
  }
  return { push, flush, status, _idle: () => chain };
}
