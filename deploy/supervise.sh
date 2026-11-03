#!/usr/bin/env bash
# 没有 launchd 时的守护（Linux / 手动）：mkdir 锁单实例，服务退出后退避 2s→60s 重启，稳定 5 分钟后重置退避。
cd "$(dirname "$0")/.." || exit 1
mkdir -p data logs; chmod 700 data
[ -f data/instance.env ] && . data/instance.env
CONFIG="${IMWB_CONFIG:-$PWD/config.json}"
LOCK=data/supervise.lock.d
ts() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then echo "supervise 已在运行 PID $old"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || { echo "拿不到锁 $LOCK"; exit 1; }
fi
echo $$ > "$LOCK/pid"
child=
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; rm -rf "$LOCK"; exit 0' TERM INT
trap 'rm -rf "$LOCK"' EXIT
delay=2
while true; do
  start=$(date +%s)
  node cli.js start --config "$CONFIG" >> logs/bridge.log 2>&1 &
  child=$!; wait "$child"; code=$?; child=
  ran=$(( $(date +%s) - start ))
  [ "$ran" -ge 300 ] && delay=2
  [ "$code" = 2 ] && { echo "[$(ts)] 配置错误（code 2），不再重启，看 logs/bridge.log" >> logs/supervise.log; exit 2; }
  echo "[$(ts)] 服务退出 code=$code 运行 ${ran}s，${delay}s 后重启" >> logs/supervise.log
  sleep "$delay"
  delay=$(( delay * 2 )); [ "$delay" -gt 60 ] && delay=60
done
