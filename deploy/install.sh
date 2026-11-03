#!/usr/bin/env bash
# macOS 安装（幂等）：npm ci → 校验配置 → 生成 LaunchAgent → launchctl bootstrap
# 用法（在仓库根目录）：bash deploy/install.sh
#   IMWB_LABEL=io.github.im-webhook-bridge.test IMWB_CONFIG=/path/config.json bash deploy/install.sh
# 首次传入的值写进 data/instance.env，start.sh / uninstall.sh / 再次 install.sh 沿用。端口取 config.json 的 port。
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$PWD"
mkdir -p data logs; chmod 700 data
[ -f data/instance.env ] && . data/instance.env
LABEL="${IMWB_LABEL:-io.github.im-webhook-bridge}"
CONFIG="${IMWB_CONFIG:-$DIR/config.json}"
printf 'IMWB_LABEL=%s\nIMWB_CONFIG=%s\n' "$LABEL" "$CONFIG" > data/instance.env
[ "$(uname)" = Darwin ] || { echo "只在 macOS 上用；Linux 用 bash deploy/start.sh"; exit 1; }
[ -f "$CONFIG" ] || { echo "没有 $CONFIG：先 cp config.example.json config.json 再改"; exit 1; }
AGENTS="$HOME/Library/LaunchAgents"; DEST="$AGENTS/$LABEL.plist"; DOM="gui/$(id -u)"

if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN/node" ]; then
  if command -v node >/dev/null; then NODE_BIN="$(dirname "$(command -v node)")"; else echo "找不到 node（需要 Node 20+）"; exit 1; fi
fi
export PATH="$NODE_BIN:$PATH"
echo "node: $NODE_BIN/node $("$NODE_BIN/node" -v)"

npm ci --no-audit --no-fund --omit=dev
find src -name '*.js' -print0 | xargs -0 -n1 node --check; node --check cli.js
node cli.js check --config "$CONFIG"
PORT="$(node -e 'import("./src/core/config.js").then(m=>console.log(m.loadConfig(process.argv[1]).port))' "$CONFIG")"

mkdir -p "$AGENTS"
sed -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__DIR__#$DIR#g" -e "s#__LABEL__#$LABEL#g" -e "s#__CONFIG__#$CONFIG#g" deploy/launchd.plist.template > "$DEST.tmp"
plutil -lint "$DEST.tmp" >/dev/null
mv "$DEST.tmp" "$DEST"; chmod 644 "$DEST"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOM/$LABEL" >/dev/null 2>&1; then
  echo "⚠️ 127.0.0.1:$PORT 已被占用（不是本服务）："; lsof -nP -iTCP:"$PORT" -sTCP:LISTEN; echo "按 PID 停掉它，或改 config.json 的 port，再重跑"; exit 1
fi

launchctl bootout "$DOM/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "$DOM" "$DEST"
launchctl enable "$DOM/$LABEL" || true
launchctl kickstart "$DOM/$LABEL" || true
sleep 4
launchctl print "$DOM/$LABEL" | grep -E "state =|pid =|last exit code" || true
curl -s --max-time 5 "http://127.0.0.1:$PORT/health" || echo "（/health 还没起来，看 logs/bridge.err.log）"
echo
echo "已安装 $DEST。日志：$DIR/logs/bridge.log"
