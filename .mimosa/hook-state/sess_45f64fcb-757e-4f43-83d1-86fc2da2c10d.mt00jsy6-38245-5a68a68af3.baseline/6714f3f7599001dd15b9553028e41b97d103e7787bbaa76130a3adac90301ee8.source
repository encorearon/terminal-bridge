#!/bin/bash
# 把项目源码同步到 setup-pkg/files/（npx 包携带的文件快照）
#
# 做的事：
#   - proxy/   → files/proxy/   （排除 node_modules, .proxy.*, package-lock）
#   - native/  → files/native/  （只带 host.js, *.template, install.sh；不带生成的 host.sh/manifest）
#   - extension 文件（manifest/background/content/popup）→ files/extension/
#
# 用法：bash setup-pkg/sync-files.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FILES_DIR="$SCRIPT_DIR/files"

echo "=== 同步源码到 $FILES_DIR ==="

# 清空重建
rm -rf "$FILES_DIR"
mkdir -p "$FILES_DIR"/{proxy,native,extension,skill/references}

# ---------- proxy ----------
echo "→ proxy/"
cp "$PROJECT_DIR"/proxy/server.js "$FILES_DIR/proxy/"
cp "$PROJECT_DIR"/proxy/arthas-guard.js "$FILES_DIR/proxy/"
cp "$PROJECT_DIR"/proxy/client-example.mjs "$FILES_DIR/proxy/"
cp "$PROJECT_DIR"/proxy/package.json "$FILES_DIR/proxy/"
# 不带 package-lock（让 npm install 在目标机器上重新解析）
# 不带 node_modules（太大，目标机器上 npm install）
# 不带 .proxy.pid / .proxy.log（运行时产物）

# ---------- native ----------
echo "→ native/"
cp "$PROJECT_DIR"/native/host.js "$FILES_DIR/native/"
cp "$PROJECT_DIR"/native/install.sh "$FILES_DIR/native/"
cp "$PROJECT_DIR"/native/host.sh.template "$FILES_DIR/native/"
cp "$PROJECT_DIR"/native/com.wssniffer.host.json.template "$FILES_DIR/native/"
# 不带生成的 host.sh / com.wssniffer.host.json（含本机绝对路径）

# ---------- extension ----------
echo "→ extension/"
cp "$PROJECT_DIR"/manifest.json "$FILES_DIR/extension/"
cp "$PROJECT_DIR"/background.js "$FILES_DIR/extension/"
cp "$PROJECT_DIR"/content.js "$FILES_DIR/extension/"
cp "$PROJECT_DIR"/popup.html "$FILES_DIR/extension/"
cp "$PROJECT_DIR"/popup.js "$FILES_DIR/extension/"

# ---------- skill ----------
echo "→ skill/"
cp "$PROJECT_DIR"/skill/SKILL.md "$FILES_DIR/skill/"
cp "$PROJECT_DIR"/skill/references/protocol.md "$FILES_DIR/skill/references/"
# skill 安装时释放到 ~/.agents/skills/jumpserver-term-bridge/，让 Agent 自动发现

# 校验关键文件都在
for f in proxy/server.js proxy/arthas-guard.js native/install.sh native/host.sh.template \
         extension/manifest.json extension/background.js extension/content.js extension/popup.html extension/popup.js \
         skill/SKILL.md skill/references/protocol.md; do
  if [ ! -f "$FILES_DIR/$f" ]; then
    echo "✗ 缺少 $f" >&2
    exit 1
  fi
done

echo ""
echo "✓ 同步完成"
echo ""
echo "文件清单："
find "$FILES_DIR" -type f | sed "s|$FILES_DIR/|  |" | sort
echo ""
echo "总大小：$(du -sh "$FILES_DIR" | cut -f1)"
