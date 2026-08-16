#!/usr/bin/env bash
# =============================================================================
# Phase 0.5 PoC v2 — OpenCode Zen 无头大脑探测(伪造 opencode 客户端指纹)
# 依据 llm-opencode-zen 插件源码(mitmproxy 抓包还原):
#   UA: opencode/${ver} ai-sdk/provider-utils/${ver} runtime/${runtime}
#   x-opencode-client/project/session/request + stream SSE 请求体
# 回答三个经验问题:
#   1) runner 出网可达 2) Bearer public 认证 + 模型行为
#   3) 客户端指纹是否影响 429(直接 curl 429 vs 伪造客户端行为)
# 用法: scripts/poc-zen-headless.sh [out_dir]
# 输出: <out_dir>/result.json · summary.txt · 原始响应(json/headers)
# 退出码: 0 = 探测完整完成(429 也是有效发现);1 = 网络/认证异常
# =============================================================================
set -uo pipefail

OUT_DIR="${1:-.dsh/state/poc}"
BASE_URL="${OPENCODE_ZEN_BASE_URL:-https://opencode.ai/zen/v1}"
MODEL="${POC_MODEL:-deepseek-v4-flash-free}"
mkdir -p "$OUT_DIR"
: > "$OUT_DIR/summary.txt"

say() { echo "[poc] $*" | tee -a "$OUT_DIR/summary.txt"; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s000; }
b64url() { openssl rand -base64 12 2>/dev/null | tr '+/' '-_' | tr -d '='; }

# ---- 客户端指纹(与插件同构;project/session 每次运行持久化到 out_dir)----
UA="${POC_USER_AGENT:-opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14}"
PROJECT_ID="${POC_PROJECT_ID:-proj_$(b64url)}"
if [ ! -f "$OUT_DIR/fingerprint.env" ]; then
  printf 'PROJECT_ID=%s\n' "$PROJECT_ID" > "$OUT_DIR/fingerprint.env"
fi
. "$OUT_DIR/fingerprint.env"
SESSION_KEY="ses_$(printf 'default:%s' "$PROJECT_ID" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=' | cut -c1-16)"

say "== Phase 0.5 PoC v2: headless Zen probe (opencode client fingerprint) =="
say "os=$(uname -sm) base=$BASE_URL model=$MODEL"
say "fingerprint: ua=$UA project=$PROJECT_ID session=$SESSION_KEY"
KEY_SET=no
[ -n "${OPENCODE_ZEN_API_KEY:-}" ] && [ "${OPENCODE_ZEN_API_KEY:-}" != "public" ] && KEY_SET=yes
say "key_variant=$KEY_SET"

# probe <name> <url> <auth> <body_file> → 写 <out>/<name>.*;echo "status ms"
probe() {
  local name="$1" url="$2" auth="$3" body="$4" t0 t1 st reqid
  reqid="msg_$(b64url)"
  t0=$(now_ms)
  curl -sS -N --max-time 120 -H "Authorization: $auth" -H "Content-Type: application/json" \
    -H "User-Agent: $UA" -H "x-opencode-client: cli" \
    -H "x-opencode-project: $PROJECT_ID" -H "x-opencode-session: $SESSION_KEY" \
    -H "x-opencode-request: $reqid" \
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

# ---- 2) chat 请求(伪造客户端,stream SSE;3 次尝试 + 退避 40/80s)----
printf '{"model":"%s","messages":[{"role":"user","content":"Reply with exactly: POC_OK"}],"stream":true,"stream_options":{"include_usage":true},"max_tokens":256,"top_p":0.95}' "$MODEL" > "$OUT_DIR/chat.body.json"
chat_status=""; chat_ms=""; attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  say "chat attempt $attempt/3 (opencode-client shape)..."
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

# ---- 4) 受控小任务验证(SSE 中拼接 content 片段,含 POC_OK 即通过)----
task_passed="no"
if [ "$chat_status" = "200" ]; then
  joined=$(grep -o '"content":"[^"]*"' "$OUT_DIR/chat.$attempt.json" 2>/dev/null | sed 's/.*:"//; s/"$//' | tr -d '\n')
  case "$joined" in *POC_OK*) task_passed="yes";; esac
  say "joined_content=$joined"
  grep -c '^data: \[DONE\]' "$OUT_DIR/chat.$attempt.json" >/dev/null 2>&1 && say "sse_done=yes" || say "sse_done=no"
fi

# ---- 5) 结论 ----
verdict="rate_limited_free"
[ "$chat_status" = "200" ] && verdict="ok"
[ "$chat_status" = "200" ] && [ "$key_status" = "200" ] && verdict="ok_free_and_key"
[ "$chat_status" != "200" ] && [ "$key_status" = "200" ] && verdict="ok_with_key"
[ "$chat_status" != "200" ] && [ "$key_status" != "" ] && [ "$key_status" != "200" ] && verdict="rate_limited_both"

rl=$(grep -iE '^(x-ratelimit|retry-after|ratelimit)' "$OUT_DIR/chat.1.headers" 2>/dev/null | tr '\n' ';' | cut -c1-300)
say "ratelimit_headers=$rl"
say "verdict=$verdict task_passed=$task_passed"

{
  echo "{"
  echo "  \"at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"os\": \"$(uname -sm)\","
  echo "  \"baseUrl\": \"$BASE_URL\","
  echo "  \"model\": \"$MODEL\","
  echo "  \"fingerprint\": { \"ua\": \"$UA\", \"projectId\": \"$PROJECT_ID\", \"sessionKey\": \"$SESSION_KEY\" },"
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
