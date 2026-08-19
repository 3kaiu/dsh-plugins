#!/usr/bin/env bash
# DSH 插件一键安装引导(无需 git clone / 本地仓库)。
# 用法: curl -fsSL https://raw.githubusercontent.com/3kaiu/dsh-plugins/main/scripts/install.sh | bash
# 下载 install-remote.mjs(独立安装器,含 SHA-256 校验)后用 node 执行。
set -euo pipefail

BASE="${DSH_PLUGIN_BASE:-https://raw.githubusercontent.com/3kaiu/dsh-plugins/main}"

command -v node >/dev/null 2>&1 || { echo "需要 node ≥ 20(DeepSeek Harness 本身即 node 应用,通常已具备): https://nodejs.org"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "需要 curl"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[install.sh] 下载安装器: $BASE/scripts/install-remote.mjs"
curl -fsSL "$BASE/scripts/install-remote.mjs" -o "$TMP/install.mjs"
node "$TMP/install.mjs" "$@"