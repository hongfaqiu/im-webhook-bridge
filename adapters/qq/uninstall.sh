#!/usr/bin/env bash
# 卸载 LaunchAgent（停掉网关，保留代码、data、logs）
cd "$(dirname "$0")" || exit 1
[ -f data/instance.env ] && . data/instance.env
LABEL="${QQBOT_LABEL:-io.github.imwebhookbridge.qq}"; DOM="gui/$(id -u)"; DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "$DOM/$LABEL" 2>/dev/null && echo "已停止 $DOM/$LABEL" || echo "$LABEL 未加载"
rm -f "$DEST" && echo "已删除 $DEST"
echo "代码和 data/（含凭证）都保留在 $PWD"
