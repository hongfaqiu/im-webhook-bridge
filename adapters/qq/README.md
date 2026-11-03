# QQ 适配器

基于 QQ 开放平台官方机器人 API（WebSocket 通道，不需要公网 IP），协议实现参考腾讯官方 `@tencent-connect/openclaw-qqbot`。

## 功能

- 扫码绑定：`node bind.js` 生成 `bind-qr.png`，手机 QQ 扫码选择或新建机器人，凭证写入 `data/credentials.json`（600）
- 私聊 / 群 @ 消息收发，图片、语音、视频、文件附件自动下载到本地
- 本地 HTTP API（默认 `127.0.0.1:8787`）：`/health`、`/pending`、`/reply`、`/ack`、`/outbox`、`/outbox/retry`
- Webhook 推送：配置 `data/webhook_url` 和 `data/webhook_key`（600）后，收到消息 4 秒防抖合并推送，`Authorization: Bearer <key>`，失败重试并记录到 `data/webhook-failed.jsonl`
- 自愈：每次 READY / RESUMED 重启心跳；token 独立定时刷新；检测休眠后的时钟跳变；连接卡住强制重连；长时间无 ACK 则退出由守护进程重启
- 单实例：先占本地端口再连 QQ，端口被占直接退出，避免同一机器人多处在线

## 安装（macOS，launchd）

```bash
cd adapters/qq
node bind.js            # 扫码绑定，完成后 Ctrl-C
printf '%s' 'https://your-webhook' > data/webhook_url
printf '%s' 'your-key' > data/webhook_key
chmod 600 data/webhook_*
bash install.sh         # npm ci + 生成 LaunchAgent + 启动
curl -s 127.0.0.1:8787/health
```

同一台机器跑多个机器人：每个机器人一份目录，安装时指定不同的标签和端口：

```bash
QQBOT_LABEL=io.github.imwebhookbridge.qq2 QQBOT_PORT=8788 bash install.sh
```

Linux 或不想用 launchd：`bash start.sh`（用 `supervise.sh` 守护）。卸载：`bash uninstall.sh`（保留代码和 data）。

## 回复消息

```bash
curl -s 127.0.0.1:8787/pending
curl -s -X POST 127.0.0.1:8787/reply -H 'Content-Type: application/json' \
  -d '{"id":"<消息 id>","content":"收到","files":[{"path":"/abs/a.pdf"}],"done":true}'
```

被动回复窗口过期时会自动改为主动消息（主动消息有月度额度）。

## 测试

```bash
node test/test-webhook.js
node test/test-inbound.js   # 部分用例需要 data/credentials.json 存在（验证拒绝外发凭证文件）
```
