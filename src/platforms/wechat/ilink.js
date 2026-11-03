// 微信 iLink Bot 协议客户端（个人微信机器人接口，ilinkai.weixin.qq.com）。
// 协议来源：腾讯微信团队给 OpenClaw 发布的 @tencent-weixin/openclaw-weixin 插件（非公开文档的内部接口，随时可能变动）。
import crypto from 'node:crypto';

export const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const CHANNEL_VERSION = '2.4.10';
export const ILINK_APP_ID = 'bot';
export const BOT_TYPE = '3';
const [ma, mi, pa] = CHANNEL_VERSION.split('.').map(Number);
export const CLIENT_VERSION = (ma << 16) | (mi << 8) | pa;
export const BASE_INFO = { channel_version: CHANNEL_VERSION, bot_agent: 'OpenClaw' };
export const MEDIA_TYPE = { image: 1, video: 2, file: 3 };

// message_id 等是 64 位整数，JSON.parse 会丢精度：先把它们变成字符串再解析
export function parseJson(text) {
  return JSON.parse(String(text).replace(/("(?:message_id|msg_id|svr_id)"\s*:\s*)(-?\d+)/g, '$1"$2"'));
}

export function randomUin() { return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString('base64'); }

export class IlinkError extends Error {
  constructor(msg, { ret, errcode, status } = {}) { super(msg); this.ret = ret; this.errcode = errcode; this.status = status; }
}

export function createIlink({ baseUrl = DEFAULT_BASE, cdnBase = DEFAULT_CDN, token = null, routeTag = null } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  function headers(post) {
    const h = { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': String(CLIENT_VERSION) };
    if (routeTag) h.SKRouteTag = String(routeTag);
    if (post) {
      h['Content-Type'] = 'application/json';
      h.AuthorizationType = 'ilink_bot_token';
      h['X-WECHAT-UIN'] = randomUin();
      if (token) h.Authorization = `Bearer ${token}`;
    }
    return h;
  }
  async function request(method, p, body, { timeoutMs = 15000, signal } = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort(); signal?.addEventListener('abort', onAbort);
    try {
      const r = await fetch(`${base}/${p}`, { method, headers: headers(method === 'POST'), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      const text = await r.text();
      if (!r.ok) throw new IlinkError(`iLink HTTP ${r.status} ${p.split('?')[0]}`, { status: r.status });
      return text ? parseJson(text) : {};
    } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
  }
  const post = (p, body, o) => request('POST', p, { ...body, base_info: BASE_INFO }, o);
  function check(resp, what) {
    const code = resp?.ret ?? resp?.errcode ?? 0;
    if (code && code !== 0) throw new IlinkError(`${what} ret=${code} ${resp.errmsg || resp.err_msg || ''}`.trim(), { ret: resp.ret, errcode: resp.errcode });
    return resp;
  }

  return {
    base,
    cdnBase,
    // ---- 登录 ----
    getBotQrcode: (localTokens = []) => request('POST', `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, { local_token_list: localTokens }),
    getQrcodeStatus: (qrcode, verifyCode) => request('GET', `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`, null, { timeoutMs: 35000 }),
    // ---- 收 ----
    notify: (what) => post(`ilink/bot/msg/notify${what}`, {}).catch(() => null),
    getUpdates: (buf, timeoutMs, signal) => post('ilink/bot/getupdates', { get_updates_buf: buf || '' }, { timeoutMs: timeoutMs + 5000, signal }),
    // ---- 发 ----
    async sendMessage(to, item, contextToken) {
      const msg = { from_user_id: '', to_user_id: to, client_id: `openclaw-weixin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, message_type: 2, message_state: 2, item_list: [item] };
      if (contextToken) msg.context_token = contextToken;
      return check(await post('ilink/bot/sendmessage', { msg }), 'sendmessage');
    },
    async getUploadUrl(body) { return check(await post('ilink/bot/getuploadurl', body), 'getuploadurl'); },
    async uploadCdn(url, cipher) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 300000);
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: cipher, signal: ctl.signal });
        await r.arrayBuffer().catch(() => null);
        if (!r.ok) throw new IlinkError(`CDN 上传 HTTP ${r.status}`, { status: r.status });
        const param = r.headers.get('x-encrypted-param');
        if (!param) throw new IlinkError('CDN 上传没返回 x-encrypted-param');
        return param;
      } finally { clearTimeout(t); }
    },
    downloadUrl: param => `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(param)}`,
    uploadUrl: (param, filekey) => `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`,
  };
}

// ---- AES-128-ECB（CDN 媒体加解密，PKCS7） ----
export function aesEncrypt(buf, key) { const c = crypto.createCipheriv('aes-128-ecb', key, null); return Buffer.concat([c.update(buf), c.final()]); }
export function aesDecrypt(buf, key) { const d = crypto.createDecipheriv('aes-128-ecb', key, null); return Buffer.concat([d.update(buf), d.final()]); }
export const decipherStream = key => crypto.createDecipheriv('aes-128-ecb', key, null);
export const cipherSize = n => Math.ceil((n + 1) / 16) * 16;

// 入站媒体的密钥：优先 item.aeskey（hex）；否则 media.aes_key 是 base64，解出 16 字节就是密钥，否则是 hex 字符串再解一次
export function mediaKey(obj) {
  if (obj?.aeskey && /^[0-9a-f]{32}$/i.test(obj.aeskey)) return Buffer.from(obj.aeskey, 'hex');
  const b64 = obj?.media?.aes_key;
  if (!b64) return null;
  const raw = Buffer.from(b64, 'base64');
  if (raw.length === 16) return raw;
  const s = raw.toString('ascii');
  if (/^[0-9a-f]{32}$/i.test(s)) return Buffer.from(s, 'hex');
  return null;
}
