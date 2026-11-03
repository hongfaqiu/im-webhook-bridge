#!/usr/bin/env bash
# Mac Mini 安装：npm ci → 权限 → 生成/复制 LaunchAgent → launchctl bootstrap（幂等，可重复跑）
# 用法：cd <安装目录> && bash install.sh
# 多个机器人：每个目录一份代码，用不同的 QQBOT_LABEL / QQBOT_PORT，例如
#   QQBOT_LABEL=io.github.imwebhookbridge.qq2 QQBOT_PORT=8788 bash install.sh
# 首次传入的值会写进 data/instance.env，之后 start.sh / uninstall.sh / 再次 install.sh 都沿用。
set -euo pipefail
cd "$(dirname "$0")"
DIR="$PWD"
mkdir -p data; chmod 700 data
[ -f data/instance.env ] && . data/instance.env
LABEL="${QQBOT_LABEL:-io.github.imwebhookbridge.qq}"; PORT="${QQBOT_PORT:-$PORT}"
printf 'QQBOT_LABEL=%s\nQQBOT_PORT=%s\n' "$LABEL" "$PORT" > data/instance.env
AGENTS="$HOME/Library/LaunchAgents"; DEST="$AGENTS/$LABEL.plist"; DOM="gui/$(id -u)"
[ "$(uname)" = Darwin ] || { echo "只在 macOS 上用；Linux 用 bash start.sh"; exit 1; }

# 找 node：优先 $NODE_BIN，其次当前 PATH（nvm 用户先 nvm use 再跑）
if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN/node" ]; then
  if command -v node >/dev/null; then NODE_BIN="$(dirname "$(command -v node)")"; else echo "找不到 node（需要 Node 20+）"; exit 1; fi
fi
export PATH="$NODE_BIN:$PATH"
echo "node: $NODE_BIN/node $("$NODE_BIN/node" -v)"

mkdir -p data logs; chmod 700 data
npm ci --no-audit --no-fund
chmod +x start.sh supervise.sh install.sh uninstall.sh
for f in data/credentials.json data/webhook_url data/webhook_key data/session.json; do [ -f "$f" ] && chmod 600 "$f"; done
for f in *.js test/*.js; do node --check "$f"; done

[ -s data/credentials.json ] || echo "⚠️ 还没有 data/credentials.json：服务会装好但不会连 QQ（先拷凭证，或 node bind.js 扫码）"
[ -f data/webhook_url ] && [ -f data/webhook_key ] || echo "⚠️ 没有 data/webhook_url / data/webhook_key：不会秒推，只能靠巡检"

# 生成 plist：把模板里的家目录 / 安装目录 / node 目录换成实际值
mkdir -p "$AGENTS"
sed -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__DIR__#$DIR#g" -e "s#__LABEL__#$LABEL#g" -e "s#__PORT__#$PORT#g" launchd.plist.template > "$DEST.tmp"
plutil -lint "$DEST.tmp" >/dev/null
mv "$DEST.tmp" "$DEST"; chmod 644 "$DEST"

# 端口被别的进程占着就停下（避免两个网关抢同一个机器人）
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOM/$LABEL" >/dev/null 2>&1; then
  echo "⚠️ 127.0.0.1:$PORT 已被占用（非本服务）："; lsof -nP -iTCP:$PORT -sTCP:LISTEN; echo "先按 PID 停掉它再重跑 install.sh"; exit 1
fi

launchctl bootout "$DOM/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "$DOM" "$DEST"
launchctl enable "$DOM/$LABEL" || true
launchctl kickstart "$DOM/$LABEL" || true
sleep 4
launchctl print "$DOM/$LABEL" | grep -E "state =|pid =|last exit code" || true
curl -s --max-time 5 http://127.0.0.1:$PORT/health || echo "（/health 还没起来，看 logs/gateway.log）"
echo
echo "已安装 ${DEST}。日志：$DIR/logs/gateway.log、$DIR/logs/gateway.err.log"
