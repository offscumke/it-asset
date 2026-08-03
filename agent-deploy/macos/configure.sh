#!/bin/bash
set -euo pipefail

# Configure the binary installed by the macOS .pkg and start its LaunchDaemon.
SERVER="http://localhost:3001"
AGENT_SECRET=""
VNC_PORT=5900
INTERVAL=300
INSTALL_DIR="/usr/local/it-asset-agent"
PLIST="/Library/LaunchDaemons/com.it-asset.agent.plist"

usage() {
  cat <<'USAGE'
用法:
  sudo configure.sh --server URL --secret SECRET [--interval SECONDS] [--vnc-port PORT]
USAGE
}

require_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    echo "错误: $1 需要一个值" >&2
    usage >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      require_value "$@"
      SERVER="$2"
      shift 2
      ;;
    --secret)
      require_value "$@"
      AGENT_SECRET="$2"
      shift 2
      ;;
    --vnc-port)
      require_value "$@"
      VNC_PORT="$2"
      shift 2
      ;;
    --interval)
      require_value "$@"
      INTERVAL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "错误: 未知参数 $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "错误: 必须使用 sudo 运行此脚本" >&2
  exit 1
fi

if [[ -z "$AGENT_SECRET" ]]; then
  echo "错误: 必须通过 --secret 提供 Agent 密钥" >&2
  exit 1
fi

BINARY="$INSTALL_DIR/it-asset-agent"
if [[ ! -x "$BINARY" ]]; then
  echo "错误: 找不到可执行文件: $BINARY" >&2
  echo "请先双击安装 .pkg，或运行旧版安装脚本完成文件复制。" >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/\&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

SERVER_XML="$(xml_escape "$SERVER")"
SECRET_XML="$(xml_escape "$AGENT_SECRET")"
INTERVAL_XML="$(xml_escape "$INTERVAL")"
VNC_PORT_XML="$(xml_escape "$VNC_PORT")"

mkdir -p "$INSTALL_DIR"
chown root:wheel "$BINARY"
chmod 755 "$BINARY"

PLIST_TMP="$(mktemp /tmp/com.it-asset.agent.XXXXXX.plist)"
trap 'rm -f "$PLIST_TMP"' EXIT
cat > "$PLIST_TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.it-asset.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BINARY</string>
    <string>--server</string>
    <string>$SERVER_XML</string>
    <string>--interval</string>
    <string>$INTERVAL_XML</string>
    <string>--vnc-port</string>
    <string>$VNC_PORT_XML</string>
    <string>--agent-secret</string>
    <string>$SECRET_XML</string>
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

/usr/bin/plutil -lint "$PLIST_TMP" >/dev/null
install -o root -g wheel -m 644 "$PLIST_TMP" "$PLIST"

/bin/launchctl bootout system "$PLIST" 2>/dev/null || true
/bin/launchctl bootstrap system "$PLIST"
/bin/launchctl enable system/com.it-asset.agent 2>/dev/null || true

echo "==> Agent 配置完成并已启动"
echo "    服务器: $SERVER"
echo "    日志: tail -f /var/log/it-asset-agent.log"
echo "    状态: sudo launchctl print system/com.it-asset.agent"
