#!/bin/bash
set -euo pipefail

# Build a real macOS Installer package from the PyInstaller executable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SOURCE_BINARY="$REPO_ROOT/agent/dist/it-asset-agent"
OUTPUT="$REPO_ROOT/agent/dist/it-asset-agent-macos-$(uname -m).pkg"
VERSION="1.0.0"

usage() {
  cat <<'USAGE'
用法:
  bash build_pkg.sh [--binary PATH] [--output PATH] [--version VERSION]

说明:
  该脚本生成真正的 macOS Installer .pkg。PyInstaller 的
  agent/build/it-asset-agent/it-asset-agent.pkg 是内部归档，不能双击安装。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary)
      [[ $# -ge 2 && -n "$2" ]] || { echo "错误: --binary 需要路径" >&2; exit 2; }
      SOURCE_BINARY="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 && -n "$2" ]] || { echo "错误: --output 需要路径" >&2; exit 2; }
      OUTPUT="$2"
      shift 2
      ;;
    --version)
      [[ $# -ge 2 && -n "$2" ]] || { echo "错误: --version 需要版本号" >&2; exit 2; }
      VERSION="$2"
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

command -v pkgbuild >/dev/null || { echo "错误: 未找到 pkgbuild，请在 macOS 上运行" >&2; exit 1; }
command -v file >/dev/null || { echo "错误: 未找到 file" >&2; exit 1; }

if [[ ! -f "$SOURCE_BINARY" ]]; then
  echo "错误: 找不到 Agent 可执行文件: $SOURCE_BINARY" >&2
  echo "请先用 PyInstaller 构建 agent/dist/it-asset-agent，或通过 --binary 指定路径。" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误: .pkg 必须在 macOS 上构建" >&2
  exit 1
fi

ARCH="$(uname -m)"
BINARY_INFO="$(file -b "$SOURCE_BINARY")"
case "$ARCH:$BINARY_INFO" in
  arm64:*"Mach-O"*arm64*) ;;
  x86_64:*"Mach-O"*x86_64*) ;;
  *)
    echo "错误: Agent 架构与当前 macOS 不匹配" >&2
    echo "    当前: $ARCH" >&2
    echo "    文件: $BINARY_INFO" >&2
    exit 1
    ;;
esac

mkdir -p "$(dirname "$OUTPUT")"
WORK_DIR="$(mktemp -d /tmp/it-asset-agent-pkg.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

PAYLOAD_ROOT="$WORK_DIR/payload"
mkdir -p "$PAYLOAD_ROOT/usr/local/it-asset-agent"
COPYFILE_DISABLE=1 install -m 755 "$SOURCE_BINARY" "$PAYLOAD_ROOT/usr/local/it-asset-agent/it-asset-agent"
COPYFILE_DISABLE=1 install -m 755 "$SCRIPT_DIR/configure.sh" "$PAYLOAD_ROOT/usr/local/it-asset-agent/configure.sh"

# Clear removable local extended attributes before packaging; macOS may retain provenance metadata.
if command -v xattr >/dev/null; then
  xattr -rc "$PAYLOAD_ROOT"
fi

# Prevent macOS copyfile from adding AppleDouble metadata entries to the payload.
COPYFILE_DISABLE=1 pkgbuild \
  --root "$PAYLOAD_ROOT" \
  --identifier com.it-asset.agent \
  --version "$VERSION" \
  --ownership recommended \
  --install-location / \
  "$OUTPUT"

echo "==> macOS 安装包已生成"
echo "    文件: $OUTPUT"
echo "    架构: $ARCH"
echo "    安装后配置: sudo /usr/local/it-asset-agent/configure.sh --server URL --secret SECRET"
