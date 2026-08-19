#!/bin/bash
# 安装 Native Messaging Host（通用版，不写死路径）
#
# 这个脚本被两种方式调用：
#   1. 直接运行：bash native/install.sh（开发模式，用当前项目目录）
#   2. 被 npx 安装包调用：传入 INSTALL_DIR 参数（释放目录，如 ~/.terminal-bridge）
#
# 做的事：
#   1. 检测 node 可执行文件路径
#   2. 从模板生成 host.sh（填入实际 node 路径 + host.js 路径）
#   3. 从模板生成 com.wssniffer.host.json（填入实际 host.sh 路径 + 插件 ID）
#   4. 复制 manifest 到 Chrome 的 NativeMessagingHosts 目录
#   5. 安装 proxy 的 npm 依赖（ws）
#
# 卸载：rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.wssniffer.host.json"

set -e

# ---------- 路径解析 ----------
# SCRIPT_DIR: 本脚本所在目录（native/）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# INSTALL_DIR: 项目根目录（native 的上一级）
# 支持外部传入（npx 包用），否则用相对路径推断
INSTALL_DIR="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"

NATIVE_DIR="$INSTALL_DIR/native"
PROXY_DIR="$INSTALL_DIR/proxy"

# ---------- 配置 ----------
# 插件 ID（由 manifest.json 的 key 字段决定，固定不变）
EXTENSION_ID="jkbnakjnbahigfefgiipfngheiafoein"

# Chrome native messaging host 目录（macOS）
DEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
DEST="$DEST_DIR/com.wssniffer.host.json"

# ---------- 前置检查 ----------
echo "=== 安装 Terminal Bridge Native Host ==="
echo "  安装目录: $INSTALL_DIR"

# 检测 node
if ! command -v node > /dev/null 2>&1; then
  echo "✗ 未找到 node，请先安装 Node.js (https://nodejs.org)"
  exit 1
fi
NODE_BIN="$(command -v node)"
echo "  node 路径: $NODE_BIN ($(node --version))"

# 检查模板存在
if [ ! -f "$NATIVE_DIR/host.sh.template" ]; then
  echo "✗ 未找到 $NATIVE_DIR/host.sh.template，项目结构不完整"
  exit 1
fi

# ---------- 1. 生成 host.sh ----------
HOST_SH="$NATIVE_DIR/host.sh"
HOST_JS="$NATIVE_DIR/host.js"
sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__HOST_JS__|$HOST_JS|g" \
    "$NATIVE_DIR/host.sh.template" > "$HOST_SH"
chmod +x "$HOST_SH"
echo "✓ 生成 host.sh → $HOST_SH"

# ---------- 2. 生成 com.wssniffer.host.json ----------
TMP_MANIFEST="$NATIVE_DIR/com.wssniffer.host.json"
sed -e "s|__HOST_SH__|$HOST_SH|g" \
    -e "s|__EXTENSION_ID__|$EXTENSION_ID|g" \
    "$NATIVE_DIR/com.wssniffer.host.json.template" > "$TMP_MANIFEST"
echo "✓ 生成 manifest → $TMP_MANIFEST"

# ---------- 3. 注册到 Chrome ----------
mkdir -p "$DEST_DIR"
cp "$TMP_MANIFEST" "$DEST"
echo "✓ 已注册到 Chrome: $DEST"

# ---------- 4. 安装 proxy 依赖 ----------
if [ -f "$PROXY_DIR/package.json" ]; then
  if [ ! -d "$PROXY_DIR/node_modules/ws" ]; then
    echo "→ 安装 proxy 依赖 (ws)..."
    (cd "$PROXY_DIR" && npm install --silent)
    echo "✓ 依赖已安装"
  else
    echo "✓ proxy 依赖已存在"
  fi
fi

echo ""
echo "=== Native Host 安装完成 ==="
