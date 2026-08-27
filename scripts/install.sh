#!/usr/bin/env bash
# DSH 插件一键安装引导(无需 git clone / 本地仓库)。
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/3kaiu/dsh-plugins/main/scripts/install.sh | bash
#   DSH_PLUGIN_REF=v0.4.0 bash -c 'curl -fsSL .../install.sh | bash'   # 生产环境钉死 tag/commit
# 下载 install-remote.mjs(独立安装器,含 SHA-256 校验)后用 node 执行。
#
# 安全: 默认仍从 main 拉取引导脚本(与官方文档一致); 生产环境请通过 DSH_PLUGIN_REF
# 钉死到不可变 tag/commit, 避免 main 被推送时引导器本身被替换。
set -euo pipefail

BASE="${DSH_PLUGIN_BASE:-https://raw.githubusercontent.com/3kaiu/dsh-plugins/${DSH_PLUGIN_REF:-main}}"

command -v node >/dev/null 2>&1 || { echo "需要 node ≥ 20(DeepSeek Harness 本身即 node 应用,通常已具备): https://nodejs.org"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "需要 curl"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[install.sh] 下载安装器(ref=${DSH_PLUGIN_REF:-main}): $BASE/scripts/install-remote.mjs"
curl -fsSL "$BASE/scripts/install-remote.mjs" -o "$TMP/install.mjs"
node "$TMP/install.mjs" "$@"