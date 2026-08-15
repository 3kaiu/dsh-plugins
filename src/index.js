import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  RetryPolicySchema,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { EventSourceParserStream } from "eventsource-parser/stream";

//#region telemetry
const DSH_HOME = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const STORAGES_DIR = join(DSH_HOME, "storages");
const QUOTA_FILE = join(STORAGES_DIR, "llm-opencode-zen-usage.json");
const DEFAULT_COOLDOWN_MS = 60000;
const PERSIST_DEBOUNCE_MS = 5000;

class QuotaTracker {
  file;
  now;
  requests = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCacheReadTokens = 0;
  totalReasoningTokens = 0;
  rateLimited = 0;
  quotaExceeded = 0;
  sessionCooldowns = {};
  requestTimes = {};
  pacing = { enabled: true, maxRequests: 3, windowMs: 20000, maxHoldMs: 15000 };
  projectId = `proj_${randomBytes(12).toString("base64url")}`;
  lastPersistAt = 0;
  constructor(file, now = () => Date.now()) {
    this.file = file;
    this.now = now;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      this.requests = data.requests ?? 0;
      this.totalInputTokens = data.totalInputTokens ?? 0;
      this.totalOutputTokens = data.totalOutputTokens ?? 0;
      this.totalCacheReadTokens = data.totalCacheReadTokens ?? 0;
      this.totalReasoningTokens = data.totalReasoningTokens ?? 0;
      this.rateLimited = data.rateLimited ?? 0;
      this.quotaExceeded = data.quotaExceeded ?? 0;
      this.sessionCooldowns = data.sessionCooldowns ?? {};
      if (typeof this.sessionCooldowns !== "object" || this.sessionCooldowns === null)
        this.sessionCooldowns = {};
      if (typeof data.cooldownUntil === "number" && data.cooldownUntil > 0)
        this.sessionCooldowns["default"] = Math.max(this.sessionCooldowns["default"] ?? 0, data.cooldownUntil);
      this.projectId = data.projectId ?? this.projectId;
    } catch {}
  }
  configurePacing(pacing) {
    if (pacing !== void 0 && pacing !== null) this.pacing = pacing;
  }
  markRequest(sessionId) {
    const bucket = this.sessionBucket(sessionId);
    const now = this.now();
    const window = Math.max(this.pacing.windowMs * 2, 1000);
    const times = (this.requestTimes[bucket] ?? []).filter((t) => now - t < window);
    times.push(now);
    this.requestTimes[bucket] = times;
  }
  // 返回发送前需要等待的毫秒数（0 = 立即发送）。
  // 目的：在触发服务端 402/429 之前主动放慢节奏（滚动窗口预算）。
  pacingDelayMs(sessionId) {
    if (!this.pacing.enabled) return 0;
    const bucket = this.sessionBucket(sessionId);
    const now = this.now();
    const window = Math.max(this.pacing.windowMs, 1000);
    const times = (this.requestTimes[bucket] ?? []).filter((t) => now - t < window);
    if (times.length < this.pacing.maxRequests) return 0;
    const oldest = Math.min(...times);
    const wait = Math.min(oldest + window - now, this.pacing.maxHoldMs);
    return Math.max(0, wait);
  }
  recordQuotaExceeded() {
    this.quotaExceeded += 1;
    this.persist(true);
  }
  recordUsage(usage) {
    this.requests += 1;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    if (usage.cacheReadTokens !== void 0) this.totalCacheReadTokens += usage.cacheReadTokens;
    if (usage.reasoningTokens !== void 0) this.totalReasoningTokens += usage.reasoningTokens;
    this.persist();
  }
  recordLimit(retryAfterMs, sessionId) {
    this.rateLimited += 1;
    this.sessionCooldowns[this.sessionBucket(sessionId)] =
      this.now() + (retryAfterMs ?? DEFAULT_COOLDOWN_MS);
    this.pruneCooldowns();
    this.persist(true);
  }
  cooldownRemainingMs(sessionId) {
    this.pruneCooldowns();
    const until = this.sessionCooldowns[this.sessionBucket(sessionId)] ?? 0;
    return Math.max(0, until - this.now());
  }
  sessionBucket(sessionId) {
    if (sessionId === void 0 || sessionId === null) return "default";
    return sessionKeyFromId(sessionId);
  }
  pruneCooldowns() {
    const now = this.now();
    for (const key of Object.keys(this.sessionCooldowns)) {
      if (this.sessionCooldowns[key] <= now) delete this.sessionCooldowns[key];
    }
  }
  cacheHitRate() {
    const billed = this.totalInputTokens + this.totalCacheReadTokens;
    return billed > 0 ? this.totalCacheReadTokens / billed : 0;
  }
  snapshot() {
    return {
      requests: this.requests,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      cacheHitRate: this.cacheHitRate(),
      rateLimited: this.rateLimited,
      quotaExceeded: this.quotaExceeded,
      sessionCooldowns: this.sessionCooldowns,
      projectId: this.projectId,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
  persist(force = false) {
    if (!force && this.now() - this.lastPersistAt < PERSIST_DEBOUNCE_MS) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
      this.lastPersistAt = this.now();
    } catch {}
  }
}

const quota = new QuotaTracker(QUOTA_FILE);

class Semaphore {
  max;
  active = 0;
  waiters = [];
  constructor(max) {
    this.max = max;
  }
  acquire(signal) {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new LlmError("cancelled while waiting for a concurrency slot", "ABORTED"));
      }, { once: true });
    });
  }
  release() {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active -= 1;
  }
}
//#endregion

//#region serialize
function reasoningEffort(effort) {
  if (effort === "off" || effort === "low" || effort === "high" || effort === "max") return effort;
  throw new LlmError(`OpenCode Zen does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}

function resolveThinking(options, defaults) {
  if (options.purpose === "session-title") return "off";
  const effort = options.reasoningEffort === void 0 ? defaults.reasoningEffort : reasoningEffort(options.reasoningEffort);
  if (defaults.thinking === "disabled" && effort !== void 0 && effort !== "off")
    throw new LlmError(`OpenCode Zen deployment does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
  return effort;
}

function flattenText(blocks) {
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function assertTextOnly(blocks) {
  if (contentHasImage(blocks))
    throw new LlmError("The OpenCode Zen adapter does not support image content.", "UNSUPPORTED_CONTENT");
}

function serializeAssistant(message) {
  const text = flattenText(message.content);
  const reasoning = message.content.filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  const toolCalls = message.content.filter((b) => b.type === "tool-call").map((b) => ({
    id: b.id,
    type: "function",
    function: { name: b.name, arguments: b.arguments },
  }));
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function serializeMessages(messages) {
  const wire = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((b) => b.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0)
      wire.push({ role: "user", content: text });
    for (const result of toolResults)
      wire.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || "(no output)",
      });
  }
  return wire;
}

function serializeTools(tools) {
  if (tools === void 0 || tools.length === 0) return void 0;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function buildWireRequest(messages, options, tools, reasoning) {
  const maxTokens = options.purpose === "session-title"
    ? Math.min(options.maxTokens, 64)
    : options.maxTokens;
  return JSON.stringify({
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    top_p: 0.95,
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.stop !== void 0 && options.stop.length > 0 ? { stop: options.stop } : {},
    ...tools !== void 0 ? { tools, tool_choice: "auto" } : {},
    ...reasoning !== "off" ? { reasoning_effort: reasoning } : {},
  });
}
//#endregion

//#region SSE parsing
const DONE = "[DONE]";
const STREAM_IDLE_TIMEOUT_CODE = "STREAM_IDLE_TIMEOUT";
const MAX_REQUEST_ATTEMPTS = 2;

async function* parseSse(stream, onComment) {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    yield data;
    if (data === DONE) return;
  }
  throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default:
      return {
        kind: "error",
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      };
  }
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== void 0 ? { reasoningTokens: reasoning } : {},
  };
}

const TOOL_ARGS_MALFORMED_CODE = "TOOL_ARGS_MALFORMED";

function repairByClosure(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  const stack = [];
  for (const ch of text) {
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      result += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
      result += ch;
      continue;
    }
    result += ch;
  }
  if (inString) result += '"';
  while (stack.length > 0) result += stack.pop();
  try {
    JSON.parse(result);
    return { ok: true, text: result };
  } catch {
    return { ok: false, text };
  }
}

function firstCompleteValue(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return { ok: false, text };
  let inString = false;
  let escaped = false;
  const stack = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
      if (stack.length === 0) {
        const candidate = text.slice(0, i + 1);
        try {
          JSON.parse(candidate);
          return { ok: true, text: candidate };
        } catch {}
        return { ok: false, text };
      }
    }
  }
  return { ok: false, text };
}

function repairToolArguments(text) {
  try {
    JSON.parse(text);
    return { ok: true, text };
  } catch {}
  const closed = repairByClosure(text);
  if (closed.ok) return closed;
  const prefix = firstCompleteValue(text);
  if (prefix.ok) return prefix;
  const maxBacktrack = Math.max(1, Math.min(Math.floor(text.length / 4), 512));
  for (let cut = text.length - 1; cut >= text.length - maxBacktrack; cut--) {
    const candidate = text.slice(0, cut);
    try {
      JSON.parse(candidate);
      return { ok: true, text: candidate };
    } catch {}
  }
  return { ok: false, text };
}

function isCjkChar(ch) {
  const code = ch.codePointAt(0);
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff);
}

function estimateCharsToTokens(text) {
  let cjk = 0;
  for (const ch of text) {
    if (isCjkChar(ch)) cjk += 1;
  }
  return cjk + Math.floor((text.length - cjk) / 4);
}

function estimateUsage(inputText, outputText, reasoningText) {
  const usage = {
    inputTokens: estimateCharsToTokens(inputText),
    outputTokens: estimateCharsToTokens(outputText),
  };
  const reasoningTokens = estimateCharsToTokens(reasoningText);
  if (reasoningTokens > 0) usage.reasoningTokens = Math.min(reasoningTokens, usage.outputTokens);
  return usage;
}

function closeBlock(block) {
  switch (block.kind) {
    case "text": return { type: "text", text: block.text };
    case "reasoning": return { type: "reasoning", text: block.text };
    case "tool-call": return {
      type: "tool-call",
      id: CallId(block.callId ?? ""),
      name: block.name ?? "",
      arguments: block.text,
    };
  }
}

async function* translate(events, context = {}) {
  const { estimateInput = null } = context;
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;

  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  };

  const estimate = () => {
    const inputText = estimateInput !== null ? estimateInput() : "";
    let outputText = textBlock?.text ?? "";
    for (const block of order)
      if (block.kind === "tool-call") outputText += block.text;
    const reasoningText = reasoningBlock?.text ?? "";
    return estimateUsage(inputText, outputText, reasoningText);
  };

  for await (const payload of events) {
    if (payload === DONE) {
      let malformed = false;
      for (const block of order) {
        if (block.kind === "tool-call") {
          const repair = repairToolArguments(block.text);
          if (repair.ok) {
            if (repair.text !== block.text) block.text = repair.text;
          } else {
            malformed = true;
          }
        }
        yield { type: "block-end", index: block.index, block: closeBlock(block) };
      }
      yield {
        type: "usage",
        usage: pendingUsage ?? estimate(),
      };
      let reason = pendingFinish ?? { kind: "stop" };
      if (malformed) {
        reason = {
          kind: "error",
          failure: {
            message: "OpenCode Zen returned tool arguments that are not valid JSON",
            code: TOOL_ARGS_MALFORMED_CODE,
          },
        };
      } else if (reason.kind === "stop" && order.length === 0) {
        reason = {
          kind: "error",
          failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE },
        };
      }
      yield { type: "finish", reason };
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;

      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }

      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== void 0 && call.id !== null) block.callId = call.id;
        if (call.function?.name !== void 0 && call.function?.name !== null) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...block.name !== void 0 ? { name: block.name } : {},
          argumentsDelta: fragment,
        };
      }

      if (typeof choice.finish_reason === "string") {
        pendingFinish = mapFinishReason(choice.finish_reason);
      }
    }

    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }

  throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion

//#region adapter
function providerRetryAfterMs(header) {
  if (!header) return void 0;
  const delay = Number(header);
  if (Number.isFinite(delay) && delay > 0) return delay * 1000;
  const parsed = Date.parse(header);
  if (Number.isFinite(parsed) && parsed > Date.now()) return parsed - Date.now();
  return void 0;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "稍后";
  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  if (seconds > 0 && parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.length > 0 ? parts.join(" ") : "1 分钟以内";
}

function rateLimitMessage(ms) {
  const wait = formatDuration(ms);
  return `OpenCode Zen 免费额度已用尽，当前处于限流状态，约 ${wait} 后可恢复使用；如需更高额度，可设置环境变量 ${DEFAULT_API_KEY_ENV}`;
}

function requestId(headers) {
  const value = headers.get("x-request-id") ?? headers.get("x-opencode-request-id");
  return value === null || value === void 0 || value.length === 0 ? void 0 : ProviderRequestId(value);
}

function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_ERROR";
  if (isContextWindowExceededError(error)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (isQuotaExceededError(error)) return QUOTA_EXCEEDED_CODE;
  return "PROVIDER_ERROR";
}

// Real OpenCode client headers captured from mitmproxy traffic against https://opencode.ai/zen/v1
// User-Agent: opencode/${version} ai-sdk/provider-utils/${version} runtime/${runtime}
// The free model is authenticated with the literal token "public".
const OPENCODE_UA = "opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

function sessionKeyFromId(sessionId) {
  // 无 sessionId 时使用基于 projectId 的稳定 key：保证请求头与冷却 bucket
  // 一致（sessionBucket 对 undefined 返回 "default"），并让服务端视角的会话稳定。
  if (sessionId === void 0)
    return `ses_${createHash("sha256").update(`default:${quota.projectId}`).digest("base64url").slice(0, 16)}`;
  return `ses_${createHash("sha256").update(String(sessionId)).digest("base64url").slice(0, 16)}`;
}

function opencodeHeaders(sessionId) {
  return {
    "user-agent": OPENCODE_UA,
    "x-opencode-client": "cli",
    "x-opencode-project": quota.projectId,
    "x-opencode-session": sessionKeyFromId(sessionId),
    "x-opencode-request": `msg_${randomBytes(12).toString("base64url")}`,
  };
}

function estimateInputText(messages) {
  return messages.map((message) => [
    typeof message.content === "string" ? message.content : "",
    message.reasoning_content ?? "",
    ...(message.tool_calls ?? []).map((call) => call.function?.arguments ?? ""),
  ].join("")).join("\n");
}

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === void 0 ? {} : { description: model.description },
    inputModalities: ["text"]
  };
}

class OpenCodeZenAdapter extends LlmAdapter {
  config;
  semaphore;
  constructor(config, semaphore) {
    super();
    this.config = config;
    this.semaphore = semaphore;
  }

  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }

  listModels(provider) {
    return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
  }

  resolveModel(provider, model, _signal) {
    const connection = this.config.options();
    const configured = connection.models.find((entry) => entry.id === model);
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
    
    // Build reasoning efforts if thinking is enabled
    let reasoning;
    if (connection.defaults.thinking !== "disabled") {
      reasoning = {
        efforts: [
          { id: "off", name: "Off", description: "No chain-of-thought; fastest responses" },
          { id: "low", name: "Low", description: "Light reasoning for quick, routine tasks" },
          { id: "high", name: "High", description: "Balanced reasoning for everyday work" },
          { id: "max", name: "Max", description: "Deep reasoning; consumes free quota fastest" },
        ],
        defaultEffort: connection.defaults.reasoningEffort ?? "high",
      };
    } else {
      reasoning = {
        efforts: [{ id: "off", name: "Off", description: "No chain-of-thought; fastest responses" }],
        defaultEffort: "off",
      };
    }
    
    return Promise.resolve({
      ...configured === void 0 ? {
        provider,
        id: model,
        name: model,
        inputModalities: ["text"]
      } : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning,
    });
  }

  async *requestStream(options, connection, apiKey, payload, watchdog, effort, estimateInput) {
    quota.markRequest(options.sessionId);
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...attributionHeaders(),
      ...opencodeHeaders(options.sessionId),
    };

    let response;
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: payload,
        signal: watchdog.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new LlmError(`OpenCode Zen API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    }

    if (!response.ok) {
      let message = `OpenCode Zen API error (HTTP ${response.status})`;
      let providerError;
      let rawBody = "";
      try {
        rawBody = await response.text();
      } catch {}
      try {
        const parsed = JSON.parse(rawBody);
        providerError = parsed?.error;
        if (providerError?.message) message = providerError.message;
        else if (parsed?.message) message = parsed.message;
      } catch {
        // 非 JSON 响应体（如 HTML 错误页/纯文本）：透出原文，避免信息被吞
        const trimmed = rawBody.trim();
        if (trimmed.length > 0) message = trimmed.slice(0, 300);
      }
      const retryAfter = providerRetryAfterMs(response.headers.get("retry-after"));
      const code = httpErrorCode(response.status, providerError);
      if (response.status === 429) {
        message = `OpenCode Zen 免费额度限流（HTTP 429）：${message}${retryAfter !== void 0 ? `，约 ${formatDuration(retryAfter)} 后可重试` : ""}；如需更高额度，可设置环境变量 ${DEFAULT_API_KEY_ENV}`;
      } else if (response.status === 402) {
        message = `OpenCode Zen 免费额度已耗尽（HTTP 402）：${message}${retryAfter !== void 0 ? `，约 ${formatDuration(retryAfter)} 后可恢复` : ""}；可设置环境变量 ${DEFAULT_API_KEY_ENV} 使用付费额度，或等待免费额度每日重置`;
      }
      throw new LlmError(message, code, {
        status: response.status,
        ...retryAfter !== void 0 ? { providerRetryAfterMs: retryAfter } : {},
        ...requestId(response.headers) !== void 0 ? { requestId: requestId(response.headers) } : {},
      });
    }

    if (!response.body)
      throw new LlmError("OpenCode Zen API returned no response body", "EMPTY_RESPONSE");

    const chunks = parseSse(response.body, () => { watchdog.pulse(); });
    yield* translate(chunks, { estimateInput });
  }

  async *stream(options) {
    const settings = this.config.options();
    const connection = {
      baseURL: settings.baseURL,
      apiKeyEnv: settings.apiKeyEnv,
    };

    const cooldownMs = quota.cooldownRemainingMs(options.sessionId);
    if (cooldownMs > 0) {
      throw new LlmError(
        rateLimitMessage(cooldownMs),
        "RATE_LIMITED",
        { providerRetryAfterMs: cooldownMs },
      );
    }

    // 主动限速：滚动窗口预算，未触发服务端 402/429 前先放缓节奏。
    // 观察到服务端约每 3 次成功请求后按窗口限流，此处用请求计数窗口压节奏。
    const pacingMs = quota.pacingDelayMs(options.sessionId);
    if (pacingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pacingMs));
    }

    await this.semaphore.acquire(options.signal);
    try {
      const apiKey = await this.config.resolveApiKey(connection);
      const messages = [
        ...options.system !== void 0 ? [{ role: "system", content: options.system }] : [],
        ...serializeMessages(options.messages),
      ];
      const tools = serializeTools(options.tools);
      let effort = resolveThinking(options, settings.defaults);

      const consumer = new AbortController();
      const upstream = options.signal === void 0
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal]);
      const watchdog = idleWatchdog(upstream, settings.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
      let emitted = false;

      try {
        for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
          const payload = buildWireRequest(messages, options, tools, effort);
          const iterator = this.requestStream(
            options,
            connection,
            apiKey,
            payload,
            watchdog,
            effort,
            () => estimateInputText(messages),
          )[Symbol.asyncIterator]();

          try {
            let lastUsage;
            while (true) {
              const result = await watchdog.next(iterator);
              if (result.done) break;
              emitted = true;
              if (result.value.type === "usage") lastUsage = result.value.usage;
              yield result.value;
            }
            if (lastUsage) quota.recordUsage(lastUsage);
            return;
          } catch (error) {
            if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) {
              throw new LlmError(
                `OpenCode Zen stream idle timeout after ${settings.streamIdleTimeoutMs}ms`,
                "TIMEOUT",
                { cause: error },
              );
            }
            if (options.signal?.aborted) {
              throw new LlmError("OpenCode Zen request aborted by caller", "ABORTED", { cause: error });
            }
            const code = error instanceof LlmError ? error.code : "TRANSPORT";
            if (code === "RATE_LIMITED") {
              // 429 = 服务端判定该 IP/项目已限流，降 effort 重试不会解除限流，
              // 反而白打一次请求并可能加重限流。直接记录冷却并抛出。
              quota.recordLimit(error.failure?.providerRetryAfterMs, options.sessionId);
              throw error;
            }
            if (code === QUOTA_EXCEEDED_CODE) {
              // 402 = 免费额度耗尽（Payment Required）。同样记录冷却避免连续白打，
              // 让外层 retryPolicy 等待冷却后重试整轮。
              quota.recordLimit(error.failure?.providerRetryAfterMs, options.sessionId);
              quota.recordQuotaExceeded();
              throw error;
            }
            if (!emitted && (code === "TRANSPORT" || code === "STREAM_CLOSED")) {
              // 内层即时重试容易连续命中同一故障，加一个带抖动的短退避。
              await new Promise((resolve) =>
                setTimeout(resolve, 250 + Math.random() * 250));
              continue;
            }
            throw error;
          } finally {
            if (iterator.return !== void 0) {
              try {
                await iterator.return();
              } catch {}
            }
          }
        }
        throw new LlmError(`OpenCode Zen request failed after ${MAX_REQUEST_ATTEMPTS} attempts`, "TRANSPORT");
      } finally {
        consumer.abort("OpenCode Zen stream consumer stopped");
      }
    } finally {
      this.semaphore.release();
    }
  }
}
//#endregion

//#region plugin registration
const PROVIDER = "opencode-zen";
const NS = settingsNamespace("llm-opencode-zen");
const DEFAULT_API_KEY_ENV = "OPENCODE_ZEN_API_KEY";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 128000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
const DEFAULT_MAX_CONCURRENT_STREAMS = 2;

const DEFAULT_MODELS = [
  {
    id: "deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash Free",
    description: "OpenCode Zen free tier: reasoning, tools, and cache-friendly streaming",
    contextWindow: 200000,
    maxTokens: 128000,
  },
];

const DEFAULT_RETRY_POLICY = {
  mode: "normal",
  maxRetries: 2,
  retryableCodes: ["RATE_LIMITED", QUOTA_EXCEEDED_CODE, "TIMEOUT", "TRANSPORT", "STREAM_CLOSED", EMPTY_RESPONSE_CODE],
  backoff: {
    initialDelayMs: 1000,
    maxDelayMs: DEFAULT_COOLDOWN_MS,
    jitterRatio: 0.1,
  },
};

const PacingSchema = z.object({
  enabled: z.boolean().default(true),
  maxRequests: z.number().step(1).min(1).default(3),
  windowMs: z.number().min(1000).max(MAX_TIMER_DELAY_MS).default(20000),
  maxHoldMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(15000),
});

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
});

const Config = z.object({
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  thinking: z.union(["enabled", "disabled"]),
  reasoningEffort: z.union(["off", "low", "high", "max"]),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxConcurrentStreams: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_STREAMS),
  pacing: PacingSchema.default({ enabled: true, maxRequests: 3, windowMs: 20000, maxHoldMs: 15000 }),
  retryPolicy: RetryPolicySchema.default(DEFAULT_RETRY_POLICY),
});

const PUBLIC_BASE_URL = "https://opencode.ai/zen/v1";
const BASE_URL_ENV = "OPENCODE_ZEN_BASE_URL";

function resolveModels(models) {
  const seen = new Set();
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error("llm-opencode-zen: catalog model ids must be non-empty");
    if (model.name !== void 0 && model.name.length === 0)
      throw new Error(`llm-opencode-zen: catalog model "${model.id}" has an empty name`);
    if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0))
      throw new Error(`llm-opencode-zen: catalog model "${model.id}" contextWindow must be a positive integer`);
    if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0))
      throw new Error(`llm-opencode-zen: catalog model "${model.id}" maxTokens must be a positive integer`);
    if (seen.has(model.id)) throw new Error(`llm-opencode-zen: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      ...(model.name === void 0 ? {} : { name: model.name }),
      ...(model.description === void 0 ? {} : { description: model.description }),
      ...(model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }),
    };
  });
}

function resolveAdapterOptions(config, environment) {
  if (config.thinking === "disabled" && config.reasoningEffort !== void 0 && config.reasoningEffort !== "off")
    throw new Error("llm-opencode-zen: only reasoningEffort \"off\" can be configured when thinking is disabled");
  if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0))
    throw new Error("llm-opencode-zen: defaultContextWindow must be a positive integer");
  if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0))
    throw new Error("llm-opencode-zen: maxTokens must be a positive safe integer");
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS)
    throw new Error(`llm-opencode-zen: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  const maxConcurrentStreams = config.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS;
  if (!Number.isInteger(maxConcurrentStreams) || maxConcurrentStreams <= 0)
    throw new Error("llm-opencode-zen: maxConcurrentStreams must be a positive integer");
  const pacing = config.pacing ?? { enabled: true, maxRequests: 3, windowMs: 20000, maxHoldMs: 15000 };
  if (!Number.isInteger(pacing.maxRequests) || pacing.maxRequests <= 0)
    throw new Error("llm-opencode-zen: pacing.maxRequests must be a positive integer");
  if (!Number.isFinite(pacing.windowMs) || pacing.windowMs <= 0 || pacing.windowMs > MAX_TIMER_DELAY_MS)
    throw new Error(`llm-opencode-zen: pacing.windowMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  if (!Number.isFinite(pacing.maxHoldMs) || pacing.maxHoldMs < 0 || pacing.maxHoldMs > MAX_TIMER_DELAY_MS)
    throw new Error(`llm-opencode-zen: pacing.maxHoldMs must be a finite number in [0, ${MAX_TIMER_DELAY_MS}]`);
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? PUBLIC_BASE_URL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    maxConcurrentStreams,
    pacing,
    retryPolicy: resolveRetryPolicy(config.retryPolicy ?? DEFAULT_RETRY_POLICY, "llm-opencode-zen: retryPolicy"),
  };
}

function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;

  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== void 0) return lastGood;
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      lastRaw = raw;
      ctx.logger.error("llm-opencode-zen: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();

  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-opencode-zen", ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== void 0 && ambient.value.length > 0)
        return assertUsableApiKey(ambient.value, "llm-opencode-zen", ref);
    }
    // OpenCode Zen free models authenticate with the literal token "public"
    return "public";
  };

  const adapter = new OpenCodeZenAdapter({
    options,
    resolveApiKey,
  }, new Semaphore(options().maxConcurrentStreams));

  quota.configurePacing(options().pacing);

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: "OpenCode Zen",
      settingsNs: NS,
      settingsPath: [],
    },
  ]);

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let registeredPolicy = options().retryPolicy;

  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source; },
    onChange: ensureRegistrationFacts,
  });
}
//#endregion

const name = "llm-opencode-zen";
const inject = ["llm"];

export {
  Config,
  OpenCodeZenAdapter,
  PUBLIC_BASE_URL,
  QuotaTracker,
  Semaphore,
  apply,
  estimateUsage,
  inject,
  name,
  quota,
  repairToolArguments,
  resolveAdapterOptions,
  translate,
};
