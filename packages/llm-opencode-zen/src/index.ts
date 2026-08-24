import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { QuotaTracker, Semaphore, sessionKeyOf, DEFAULT_COOLDOWN_MS } from "@3kaiu/dsh-plugin-kit";
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
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

//#region telemetry
const DSH_HOME = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
// DSH_QUOTA_FILE 可覆盖 usage 文件路径(测试隔离 / 多实例部署)
const QUOTA_FILE =
  process.env.DSH_QUOTA_FILE?.length > 0 ? process.env.DSH_QUOTA_FILE : join(DSH_HOME, "storages", "llm-opencode-zen-usage.json");

const quota = new QuotaTracker(QUOTA_FILE);


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
    ...(reasoning.length > 0 || toolCalls.length > 0 ? { reasoning_content: reasoning } : {}),
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
    default: {
      // OpenCode Zen 网关到上游中断时不报 HTTP 错误,而是以
      // finish_reason="network_error" 正常收流——本质是传输层故障,
      // 映射为 TRANSPORT 以接入内外两层重试,否则一次抖动即终止整轮。
      const code = reason === "network_error" ? "TRANSPORT" : reason.toUpperCase();
      return {
        kind: "error",
        failure: { message: `model stopped: ${reason}`, code },
      };
    }
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

//#region model-catalog
// 动态免费模型目录:OpenCode 官方模型元数据发布在 models.dev(provider id = "opencode",
// api 指向 zen/v1),其中 cost.input/output 全为 0 的即免费模型;但 models.dev 会保留
// 已下线的条目,所以再与 live 端点 {baseURL}/models(当前实际在服务的 id)取交集。
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_PROVIDER = "opencode";
const DEFAULT_CATALOG_REFRESH_MS = 3600000;
// 拉取失败时的负缓存:避免每次请求都重试挂掉的源(离线环境快速回退到静态目录)
const CATALOG_ERROR_TTL_MS = 60000;

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

function toCatalogEntry(id, meta) {
  return {
    id,
    name: meta.name ?? id,
    ...(meta.description === void 0 ? {} : { description: meta.description }),
    ...(meta.limit?.context === void 0 ? {} : { contextWindow: meta.limit.context }),
    ...(meta.limit?.output === void 0 ? {} : { maxTokens: meta.limit.output }),
    // reasoning:false 的免费模型(如 trinity-large-preview-free)请求时必须强制 effort=off
    reasoning: meta.reasoning !== false,
    deprecated: meta.status === "deprecated" || void 0,
  };
}

// 免费模型排序:非 deprecated 优先,其余保持源顺序(稳定)
function orderCatalog(models, preferredModel) {
  const indexed = models.map((model, index) => ({ model, index }));
  indexed.sort((a, b) => {
    if (a.model.id === preferredModel && b.model.id !== preferredModel) return -1;
    if (b.model.id === preferredModel && a.model.id !== preferredModel) return 1;
    if ((a.model.deprecated ?? false) !== (b.model.deprecated ?? false))
      return a.model.deprecated ? 1 : -1;
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.model);
}

async function fetchFreeModels(baseURL, apiKey) {
  const [live, meta] = await Promise.all([
    fetchJson(`${baseURL}/models`, { Authorization: `Bearer ${apiKey}` }),
    fetchJson(MODELS_DEV_URL, {}),
  ]);
  const servedIds = new Set((live?.data ?? []).map((entry) => entry?.id).filter(Boolean));
  const metas = meta?.[MODELS_DEV_PROVIDER]?.models ?? {};
  const models = Object.entries(metas)
    .filter(([id, m]) => servedIds.has(id) && Number(m?.cost?.input) === 0 && Number(m?.cost?.output) === 0)
    .map(([id, m]) => toCatalogEntry(id, m));
  if (models.length === 0) throw new Error(`no free models found for ${baseURL}`);
  return models;
}

// 模块级缓存(按 baseURL 隔离):正向 TTL 直接复用;失败短 TTL 负缓存;inflight 去并发
const catalogCache = new Map();

// 测试/多实例隔离:清空目录缓存
function resetCatalogCache() {
  catalogCache.clear();
}

async function freeModelCatalog(baseURL, apiKey, refreshMs) {
  const now = Date.now();
  const hit = catalogCache.get(baseURL);
  if (hit !== void 0) {
    if (hit.pending !== void 0) return hit.pending;
    if (hit.expiresAt > now) {
      if (hit.error !== void 0) throw hit.error;
      return hit.models;
    }
  }
  const pending = (async () => {
    try {
      const models = await fetchFreeModels(baseURL, apiKey);
      catalogCache.set(baseURL, { expiresAt: Date.now() + refreshMs, models });
      return models;
    } catch (error) {
      catalogCache.set(baseURL, { expiresAt: Date.now() + CATALOG_ERROR_TTL_MS, error });
      throw error;
    }
  })();
  catalogCache.set(baseURL, { ...hit, pending });
  try {
    return await pending;
  } finally {
    const entry = catalogCache.get(baseURL);
    if (entry?.pending === pending) delete entry.pending;
  }
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

// Real OpenCode client headers captured from mitmproxy traffic against https://opencode.ai/zen/v1
// User-Agent: opencode/${version} ai-sdk/provider-utils/${version} runtime/${runtime}
// The free model is authenticated with the literal token "public".
//
// ⚠️ 脆弱性声明: 这是对 OpenCode Zen 免费接口的"模拟官方客户端"做法,
// 服务端一旦校验 UA/增加签名,适配器可能失效;UA 可通过配置 userAgent 覆盖,
// 也允许设置成真实环境的值(如 opencode/1.x.x)。
const OPENCODE_UA = "opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

function formatDuration(ms, locale = "zh") {
  if (!Number.isFinite(ms) || ms <= 0) return locale === "en" ? "shortly" : "稍后";
  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (locale === "en") {
    const parts = [];
    if (days > 0) parts.push(`${days} day${days > 1 ? "s" : ""}`);
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? "s" : ""}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
    if (seconds > 0 && parts.length === 0) parts.push(`${seconds} second${seconds > 1 ? "s" : ""}`);
    return parts.length > 0 ? parts.join(" ") : "under a minute";
  }
  const parts = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  if (seconds > 0 && parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.length > 0 ? parts.join(" ") : "1 分钟以内";
}

function rateLimitMessage(ms, locale, apiKeyEnv) {
  const wait = formatDuration(ms, locale);
  if (locale === "en") {
    return `OpenCode Zen free quota exhausted; rate-limited for about ${wait}. Set env ${apiKeyEnv} for a higher quota.`;
  }
  return `OpenCode Zen 免费额度已用尽，当前处于限流状态，约 ${wait} 后可恢复使用；如需更高额度，可设置环境变量 ${apiKeyEnv}`;
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

function opencodeHeaders(sessionId, userAgent, projectId) {
  return {
    "user-agent": userAgent,
    "x-opencode-client": "cli",
    "x-opencode-project": projectId,
    "x-opencode-session": sessionKeyOf(sessionId, projectId),
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

  // 解析当前生效的模型目录:custom = 配置的静态目录;auto = 动态拉取免费模型,
  // 拉取失败(离线/源不可用)时回退到静态目录并告警一次。
  async catalogModels(settings) {
    if (settings.catalog !== "auto") return settings.models;
    try {
      const apiKey = await this.config.resolveApiKey(settings);
      return await freeModelCatalog(settings.baseURL, apiKey, settings.catalogRefreshMs);
    } catch (error) {
      this.config.warn?.(
        `llm-opencode-zen: 免费模型目录拉取失败,回退到静态目录(${settings.models.length} 个);可用 catalog:"custom" 显式配置模型`,
        error,
      );
      return settings.models;
    }
  }

  async findModel(settings, modelId) {
    const models = await this.catalogModels(settings);
    return models.find((entry) => entry.id === modelId);
  }

  async listModels(provider) {
    const settings = this.config.options();
    const models = orderCatalog(await this.catalogModels(settings), settings.defaultModel);
    return Promise.resolve(models.map((model) => modelInfo(provider, model)));
  }

  async resolveModel(provider, model, _signal) {
    const connection = this.config.options();
    const configured = await this.findModel(connection, model);
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
      ...opencodeHeaders(options.sessionId, connection.userAgent, quota.projectId),
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
      const locale = connection.locale ?? "zh";
      if (response.status === 429) {
        message = locale === "en"
          ? `OpenCode Zen free-tier rate limit (HTTP 429): ${message}${retryAfter !== void 0 ? `; retry in about ${formatDuration(retryAfter, locale)}` : ""}; set env ${DEFAULT_API_KEY_ENV} for a higher quota`
          : `OpenCode Zen 免费额度限流（HTTP 429）：${message}${retryAfter !== void 0 ? `，约 ${formatDuration(retryAfter, locale)} 后可重试` : ""}；如需更高额度，可设置环境变量 ${DEFAULT_API_KEY_ENV}`;
      } else if (response.status === 402) {
        message = locale === "en"
          ? `OpenCode Zen free quota exhausted (HTTP 402): ${message}${retryAfter !== void 0 ? `; recovers in about ${formatDuration(retryAfter, locale)}` : ""}; set env ${DEFAULT_API_KEY_ENV} for paid quota or wait for the daily free reset`
          : `OpenCode Zen 免费额度已耗尽（HTTP 402）：${message}${retryAfter !== void 0 ? `，约 ${formatDuration(retryAfter, locale)} 后可恢复` : ""}；可设置环境变量 ${DEFAULT_API_KEY_ENV} 使用付费额度，或等待免费额度每日重置`;
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
      userAgent: settings.userAgent,
      locale: settings.locale,
    };

    const cooldownMs = quota.cooldownRemainingMs(options.sessionId);
    if (cooldownMs > 0) {
      throw new LlmError(
        rateLimitMessage(cooldownMs, connection.locale, DEFAULT_API_KEY_ENV),
        "RATE_LIMITED",
        { providerRetryAfterMs: cooldownMs },
      );
    }

    // 主动限速：滚动窗口预算，未触发服务端 402/429 前先放缓节奏。
    // 观察到服务端约每 3 次成功请求后按窗口限流，此处用请求计数窗口压节奏。
    const pacingMs = quota.pacingDelayMs(options.sessionId);
    if (pacingMs > 0) {
      // 等待可被 abort 中断:调用方取消时不用干等满 pacing(≤15s)
      await new Promise((resolve) => {
        const onAbort = () => { clearTimeout(timer); finish(); };
        function finish() { options.signal?.removeEventListener("abort", onAbort); resolve(); }
        const timer = setTimeout(finish, pacingMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
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
      // 免费目录中 reasoning:false 的模型不支持推理,强制 off(覆盖全局默认档位)
      if (effort !== "off" && (await this.findModel(settings, options.model))?.reasoning === false)
        effort = "off";

      const consumer = new AbortController();
      const upstream = options.signal === void 0
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal]);
      const watchdog = idleWatchdog(upstream, settings.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
      let emitted = false;

      const payload = buildWireRequest(messages, options, tools, effort);
      try {
        for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
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

//#region zen-models remote
// 设置弹窗「插件 → OpenCode Zen 模型」tab 的后端:
//   listFree  —— 返回当前可用免费模型目录(auto=动态交集;custom=静态配置)
//   applyFree —— 把勾选的模型经官方 settings 服务写回 settings.yaml
//     (catalog=custom + models 全量字段,走 schema 校验/持久化/变更广播,
//      浏览器端配置卡即时刷新,无需重启)
// 注意:SRC 描述符从方法源码解析参数名,此文件构建时禁止 minify。
let activeAdapter = null;

class ZenModelsGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "zenModels");
  }

  @Remote("listFree")
  async listFree() {
    if (activeAdapter === null) throw new Error("llm-opencode-zen adapter is not ready");
    const settings = activeAdapter.config.options();
    const models = orderCatalog(await activeAdapter.catalogModels(settings), settings.defaultModel);
    return {
      catalogMode: settings.catalog,
      defaultModel: settings.defaultModel ?? null,
      models: models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        ...(model.description === void 0 ? {} : { description: model.description }),
        ...(model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }),
        ...(model.deprecated === void 0 ? {} : { deprecated: true }),
      })),
    };
  }

  @Remote("applyFree")
  async applyFree(models) {
    if (!Array.isArray(models) || models.length === 0)
      throw new Error("请至少选择一个模型");
    if (activeAdapter === null) throw new Error("llm-opencode-zen adapter is not ready");
    const settings = activeAdapter.config.options();
    const seen = new Set();
    const section = models.map((entry) => {
      const raw = typeof entry === "string" ? { id: entry } : entry;
      const id = String(raw?.id ?? "").trim();
      if (id.length === 0) throw new Error("模型 id 不能为空");
      if (seen.has(id)) throw new Error(`重复的模型 id: ${id}`);
      seen.add(id);
      return {
        id,
        ...(raw.name === void 0 ? {} : { name: String(raw.name) }),
        ...(raw.description === void 0 ? {} : { description: String(raw.description) }),
        ...(raw.contextWindow === void 0 ? {} : { contextWindow: Number(raw.contextWindow) }),
        ...(raw.maxTokens === void 0 ? {} : { maxTokens: Number(raw.maxTokens) }),
      };
    });
    // 官方写回通道:schema 校验 + yaml 持久化 + revision 广播(浏览器配置卡即时刷新)
    await this.ctx.get("settings").update(NS, {
      catalog: "custom",
      ...(settings.defaultModel !== void 0 && section.some((m) => m.id === settings.defaultModel)
        ? {}
        : { defaultModel: section[0].id }),
      models: section,
    });
    return { applied: section.length };
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
  reasoning: z.boolean(),
});

const Config = z.object({
  apiKeyEnv: z.string().role("credential-ref"),
  baseURL: z.string(),
  // auto(默认):动态拉取 OpenCode 免费模型目录;custom:使用下方 models 静态目录
  catalog: z.union(["auto", "custom"]),
  // 首选模型 id:目录排序置顶(agent-default-model 建议填同一个 id)
  defaultModel: z.string(),
  // auto 模式目录刷新间隔
  catalogRefreshMs: z.number().step(1).min(60000).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CATALOG_REFRESH_MS),
  thinking: z.union(["enabled", "disabled"]),
  reasoningEffort: z.union(["off", "low", "high", "max"]),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default([]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxConcurrentStreams: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_STREAMS),
  pacing: PacingSchema.default({ enabled: true, maxRequests: 3, windowMs: 20000, maxHoldMs: 15000 }),
  retryPolicy: RetryPolicySchema.default(DEFAULT_RETRY_POLICY),
  locale: z.union(["zh", "en"]).default("zh"),
  userAgent: z.string().default(OPENCODE_UA),
});

const PUBLIC_BASE_URL = "https://opencode.ai/zen/v1";
const BASE_URL_ENV = "OPENCODE_ZEN_BASE_URL";

function resolveModels(models) {
  const seen = new Set();
  return (models ?? []).map((model) => {
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
      ...(model.reasoning === void 0 ? {} : { reasoning: model.reasoning }),
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
  const catalogRefreshMs = config.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS;
  if (!Number.isFinite(catalogRefreshMs) || catalogRefreshMs < 60000 || catalogRefreshMs > MAX_TIMER_DELAY_MS)
    throw new Error(`llm-opencode-zen: catalogRefreshMs must be a finite number in [60000, ${MAX_TIMER_DELAY_MS}]`);
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? PUBLIC_BASE_URL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    catalog: config.catalog === "custom" ? "custom" : "auto",
    ...(config.defaultModel === void 0 ? {} : { defaultModel: config.defaultModel }),
    models: resolveModels(config.models),
    catalogRefreshMs,
    streamIdleTimeoutMs,
    maxConcurrentStreams,
    pacing,
    retryPolicy: resolveRetryPolicy(config.retryPolicy ?? DEFAULT_RETRY_POLICY, "llm-opencode-zen: retryPolicy"),
    locale: config.locale ?? "zh",
    userAgent: config.userAgent ?? OPENCODE_UA,
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
    warn: (message, cause) => {
      ctx.logger.warn(message);
      if (cause !== void 0) ctx.logger.warn(cause);
    },
  }, new Semaphore(options().maxConcurrentStreams));
  activeAdapter = adapter;

  // 「获取免费模型」remote(浏览器 tab 后端)
  new ZenModelsGateway(ctx);

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
  MODELS_DEV_PROVIDER,
  MODELS_DEV_URL,
  OpenCodeZenAdapter,
  PUBLIC_BASE_URL,
  ZenModelsGateway,
  apply,
  estimateUsage,
  freeModelCatalog,
  inject,
  name,
  orderCatalog,
  quota,
  repairToolArguments,
  resetCatalogCache,
  resolveAdapterOptions,
  translate,
};
// QuotaTracker/Semaphore/sessionKeyOf 由 @3kaiu/dsh-plugin-kit 提供,
// 保持 re-export 兼容既有引用方。
export { QuotaTracker, Semaphore, sessionKeyOf } from "@3kaiu/dsh-plugin-kit";
