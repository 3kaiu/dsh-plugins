#!/usr/bin/env bash
# =============================================================================
# Phase 0.5 PoC — OpenCode Zen 无头大脑探测(在 CI runner 上运行)
# 回答三个经验问题:
#   1) runner 出网是否可达 opencode.ai(Zen 端点)
#   2) 免费层 Bearer public 认证与模型基本行为
#   3) 429/限流行为,以及 OPENCODE_ZEN_API_KEY 提额路径是否可用
# 用法: scripts/poc-zen-headless.sh [out_dir]
# 输出: <out_dir>/result.json(机器可读)· <out_dir>/summary.txt(人读)
# 退出码: 0 = 探测完整完成(429 也是有效发现);1 = 网络/认证异常(探测无效)
# =============================================================================
set -uo pipefail

OUT_DIR="${1:-.dsh/state/poc}"
BASE_URL="${OPENCODE_ZEN_BASE_URL:-https://opencode.ai/zen/v1}"
MODEL="${POC_MODEL:-deepseek-v4-flash-free}"
mkdir -p "$OUT_DIR"
: > "$OUT_DIR/summary.txt"

say() { echo "[poc] $*" | tee -a "$OUT_DIR/summary.txt"; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s000; }

say "== Phase 0.5 PoC: headless Zen probe =="
say "os=$(uname -sm) base=$BASE_URL model=$MODEL auth=free(public)"
KEY_SET=no
[ -n "${OPENCODE_ZEN_API_KEY:-}" ] && [ "${OPENCODE_ZEN_API_KEY:-}" != "public" ] && KEY_SET=yes
say "key_variant=$KEY_SET"

# probe <name> <url> <auth> <body_file> → 写 <out>/<name>.{json,headers,status,err};echo "status ms"
probe() {
  local name="$1" url="$2" auth="$3" body="$4" t0 t1 st
  t0=$(now_ms)
  curl -sS --max-time 60 -H "Authorization: $auth" -H "Content-Type: application/json" \
    ${body:+-d "@$body"} -D "$OUT_DIR/$name.headers" -o "$OUT_DIR/$name.json" \
    -w "%{http_code}" "$url" > "$OUT_DIR/$name.status" 2> "$OUT_DIR/$name.err"
  t1=$(now_ms)
  st=$(cat "$OUT_DIR/$name.status" 2>/dev/null || echo 000)
  echo "$st $((t1 - t0))"
}

# ---- 1) 出网 + 模型列表 ----
read -r ms_st ms_ms <<< "$(probe models "$BASE_URL/models" "Bearer public" "")"
say "models: status=$ms_st latency=${ms_ms}ms"
if [ "$ms_st" = "000" ]; then
  say "FATAL: models unreachable → verdict=unreachable"
  echo '{"verdict":"unreachable"}' > "$OUT_DIR/result.json"
  exit 1
fi
if [ "$ms_st" = "401" ] || [ "$ms_st" = "403" ]; then
  say "FATAL: auth failed → verdict=auth_failed"
  echo '{"verdict":"auth_failed"}' > "$OUT_DIR/result.json"
  exit 1
fi
model_present="no"
grep -q ""$MODEL"" "$OUT_DIR/models.json" 2>/dev/null && model_present="yes"
say "model_present=$model_present"

# ---- 2) chat 请求(免费层,3 次尝试 + 退避 40/80s)----
printf '{"model":"%s","messages":[{"role":"user","content":"Reply with exactly: POC_OK"}],"max_tokens":16,"stream":false}' "$MODEL" > "$OUT_DIR/chat.body.json"
chat_status=""; chat_ms=""; attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  say "chat attempt $attempt/3 (free tier)..."
  read -r cs cms <<< "$(probe "chat.$attempt" "$BASE_URL/chat/completions" "Bearer public" "$OUT_DIR/chat.body.json")"
  say "  -> status=$cs latency=${cms}ms"
  echo "{\"attempt\":$attempt,\"status\":\"$cs\",\"latencyMs\":$cms}" >> "$OUT_DIR/chat.attempts.jsonl"
  if [ "$cs" = "200" ]; then chat_status=200; chat_ms=$cms; break; fi
  if [ "$attempt" -lt 3 ]; then
    wait_ms=$((attempt * 40))
    say "  backoff ${wait_ms}s..."
    sleep "$wait_ms"
  fi
done

# ---- 3) 提额路径(仅当配置了 OPENCODE_ZEN_API_KEY secret)----
key_status=""; key_ms=""
if [ "$KEY_SET" = "yes" ]; then
  say "chat with OPENCODE_ZEN_API_KEY..."
  read -r ks kms <<< "$(probe "chat.key" "$BASE_URL/chat/completions" "Bearer $OPENCODE_ZEN_API_KEY" "$OUT_DIR/chat.body.json")"
  say "  -> status=$ks latency=${kms}ms"
  key_status=$ks; key_ms=$kms
fi

# ---- 4) 受控小任务验证(内容含 POC_OK)----
task_passed="no"
if [ "$chat_status" = "200" ]; then
  ans=$(grep -o '"content":"[^"]*"' "$OUT_DIR/chat.$attempt.json" 2>/dev/null | head -1 | cut -d'"' -f4)
  case "$ans" in *POC_OK*) task_passed="yes";; esac
  say "answer=$ans"
fi

# ---- 5) 结论 ----
verdict="rate_limited_free"
[ "$chat_status" = "200" ] && verdict="ok"
[ "$chat_status" = "200" ] && [ "$key_status" = "200" ] && verdict="ok_free_and_key"
[ "$chat_status" != "200" ] && [ "$key_status" = "200" ] && verdict="ok_with_key"
[ "$chat_status" != "200" ] && [ "$key_status" != "" ] && [ "$key_status" != "200" ] && verdict="rate_limited_both"

rl=$(grep -iE '^(x-ratelimit|retry-after)' "$OUT_DIR/chat.1.headers" 2>/dev/null | tr '\n' ';' | cut -c1-300)
say "ratelimit_headers=$rl"
say "verdict=$verdict task_passed=$task_passed"

{
  echo "{"
  echo "  \"at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"os\": \"$(uname -sm)\","
  echo "  \"baseUrl\": \"$BASE_URL\","
  echo "  \"model\": \"$MODEL\","
  echo "  \"models\": { \"status\": \"$ms_st\", \"modelPresent\": \"$model_present\" },"
  echo "  \"chatFree\": { \"status\": \"$chat_status\", \"latencyMs\": \"$chat_ms\" },"
  echo "  \"keyVariant\": { \"status\": \"$key_status\", \"latencyMs\": \"$key_ms\" },"
  echo "  \"taskPassed\": \"$task_passed\","
  echo "  \"verdict\": \"$verdict\""
  echo "}"
} > "$OUT_DIR/result.json"

echo "==== result.json ===="
cat "$OUT_DIR/result.json"
exit 0
