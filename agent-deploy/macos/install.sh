#!/bin/bash
set -euo pipefail

# IT Asset Agent - macOS 安装脚本
# 用法: sudo bash install.sh --server http://YOUR_SERVER:3001 --secret SECRET
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/usr/local/it-asset-agent"
BINARY="$SCRIPT_DIR/it-asset-agent"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "错误: 必须使用 sudo 运行此脚本" >&2
  exit 1
fi

if [[ ! -f "$BINARY" ]]; then
  echo "错误: 找不到 Agent 可执行文件: $BINARY" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install -o root -g wheel -m 755 "$BINARY" "$INSTALL_DIR/it-asset-agent"

if [[ ! -x "$SCRIPT_DIR/configure.sh" ]]; then
  echo "错误: 找不到配置脚本: $SCRIPT_DIR/configure.sh" >&2
  exit 1
fi

exec "$SCRIPT_DIR/configure.sh" "$@"
