#!/bin/bash
# IT Asset Agent - macOS 安装脚本
# 用法: sudo bash install.sh --server http://YOUR_SERVER:3001

SERVER="http://localhost:3001"
AGENT_SECRET=""
VNC_PORT=5900
INTERVAL=300

while [[ $# -gt 0 ]]; do
  case $1 in
    --server) SERVER="$2"; shift 2 ;;
    --secret) AGENT_SECRET="$2"; shift 2 ;;
    --vnc-port) VNC_PORT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$AGENT_SECRET" ]]; then
  echo "错误: 必须通过 --secret 提供 Agent 密钥" >&2
  exit 1
fi

INSTALL_DIR="/usr/local/it-asset-agent"
PLIST="/Library/LaunchDaemons/com.it-asset.agent.plist"

echo "==> 安装 IT Asset Agent"
echo "    服务器: $SERVER"

# 安装二进制
mkdir -p "$INSTALL_DIR"
cp "$(dirname "$0")/it-asset-agent" "$INSTALL_DIR/it-asset-agent"
chmod +x "$INSTALL_DIR/it-asset-agent"

# 写 LaunchDaemon plist (开机自启，以 root 运行)
cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.it-asset.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/it-asset-agent</string>
    <string>--server</string>
    <string>$SERVER</string>
    <string>--interval</string>
    <string>$INTERVAL</string>
    <string>--vnc-port</string>
    <string>$VNC_PORT</string>
    <string>--agent-secret</string>
    <string>$AGENT_SECRET</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/it-asset-agent.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/it-asset-agent.log</string>
</dict>
</plist>
PLIST

# 加载服务
launchctl unload "$PLIST" 2>/dev/null
launchctl load -w "$PLIST"

echo "==> 安装完成！Agent 已在后台运行"
echo "    日志: tail -f /var/log/it-asset-agent.log"
echo "    卸载: sudo launchctl unload $PLIST && sudo rm -rf $INSTALL_DIR $PLIST"
