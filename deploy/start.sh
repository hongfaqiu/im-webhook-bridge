#!/usr/bin/env bash
# 幂等启动：macOS 装了 LaunchAgent 就交给 launchd；否则后台起 deploy/supervise.sh（已在跑则不动）
cd "$(dirname "$0")/.." || exit 1
mkdir -p data logs; chmod 700 data
[ -f data/instance.env ] && . data/instance.env
LABEL="${IMWB_LABEL:-io.github.im-webhook-bridge}"
[ -d node_modules/ws ] && [ -d node_modules/qrcode ] || npm ci --silent --omit=dev >> logs/npm.log 2>&1
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
if [ "$(uname)" = Darwin ] && [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then
  dom="gui/$(id -u)"
  launchctl print "$dom/$LABEL" >/dev/null 2>&1 || launchctl bootstrap "$dom" "$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl kickstart "$dom/$LABEL" && echo "已交给 launchd：$dom/$LABEL（已在跑则不动）"
  exit 0
fi
if [ -f data/supervise.lock.d/pid ] && alive "$(cat data/supervise.lock.d/pid)"; then
  echo "supervise 已在运行 PID $(cat data/supervise.lock.d/pid)"; exit 0
fi
nohup bash deploy/supervise.sh >> logs/supervise.log 2>&1 < /dev/null &
disown 2>/dev/null || true
echo "已后台启动 supervise.sh PID $!"
