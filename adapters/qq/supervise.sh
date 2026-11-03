#!/usr/bin/env bash
# 没有 launchd 时的守护（Linux / 手动）：mkdir 锁单实例（macOS 没有 flock），gateway 退出后退避 2s→60s 重启，稳定 5 分钟后重置退避。
# macOS 上正常由 launchd（install.sh 安装）直接守护 node gateway.js，不用这个脚本。
cd "$(dirname "$0")" || exit 1
LOCK=data/supervise.lock.d
ts() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then echo "supervise 已在运行 PID $old"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || { echo "拿不到锁 $LOCK"; exit 1; }
fi
echo $$ > "$LOCK/pid"; echo $$ > data/supervise.pid
child=
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; rm -rf "$LOCK"; exit 0' TERM INT
trap 'rm -rf "$LOCK"' EXIT
delay=2
while true; do
  if [ ! -s data/credentials.json ]; then echo "[$(ts)] 无凭证，supervise 退出" >> logs/supervise.log; exit 2; fi
  start=$(date +%s)
  node gateway.js >> logs/gateway.log 2>&1 &
  child=$!; wait "$child"; code=$?; child=
  ran=$(( $(date +%s) - start ))
  [ "$ran" -ge 300 ] && delay=2
  echo "[$(ts)] gateway 退出 code=$code 运行 ${ran}s，${delay}s 后重启" >> logs/supervise.log
  sleep "$delay"
  delay=$(( delay * 2 )); [ "$delay" -gt 60 ] && delay=60
done
