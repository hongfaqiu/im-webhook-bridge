#!/usr/bin/env bash
# 幂等启动（macOS / Linux 通用，不用 setsid、flock、GNU date）：
#   缺依赖 → npm ci；无凭证 → 后台 bind.js（扫码绑定）；
#   有凭证 → macOS 装了 launchd 任务就交给 launchd（kickstart）；否则后台起 supervise.sh（mkdir 锁单实例）。
cd "$(dirname "$0")" || exit 1
[ -f data/instance.env ] && . data/instance.env
LABEL="${QQBOT_LABEL:-io.github.imwebhookbridge.qq}"; [ -n "${QQBOT_PORT:-}" ] && export QQBOT_PORT
mkdir -p data logs; chmod 700 data
[ -d node_modules/ws ] && [ -d node_modules/qrcode ] || { npm ci --silent >> logs/npm.log 2>&1 || npm i --silent >> logs/npm.log 2>&1; }
[ -f data/credentials.json ] && chmod 600 data/credentials.json
for f in data/webhook_url data/webhook_key; do [ -f "$f" ] && chmod 600 "$f"; done
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
if [ ! -s data/credentials.json ]; then
  if [ -f data/bind.pid ] && alive "$(cat data/bind.pid)"; then echo "bind.js 已在运行 PID $(cat data/bind.pid)，二维码: $PWD/bind-qr.png"; exit 0; fi
  nohup node bind.js >> logs/bind.log 2>&1 < /dev/null &
  echo $! > data/bind.pid; disown 2>/dev/null || true
  echo "无凭证，已后台启动 bind.js PID $!，二维码将写到 $PWD/bind-qr.png"
  exit 0
fi
if [ "$(uname)" = Darwin ] && [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  dom="gui/$(id -u)"
  launchctl print "$dom/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "$dom" "$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl kickstart "$dom/$LABEL" && echo "已交给 launchd：$dom/$LABEL（已在跑则不动）"
  exit 0
fi
if [ -f data/supervise.lock.d/pid ] && alive "$(cat data/supervise.lock.d/pid)"; then
  echo "supervise 已在运行 PID $(cat data/supervise.lock.d/pid)"; exit 0
fi
nohup bash supervise.sh >> logs/supervise.log 2>&1 < /dev/null &
disown 2>/dev/null || true
echo "已后台启动 supervise.sh PID $!"
