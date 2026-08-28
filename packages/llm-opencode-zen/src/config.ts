import z from "@deepseek-ai/schemastery";
import { EMPTY_RESPONSE_CODE, QUOTA_EXCEEDED_CODE, RetryPolicySchema, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { DEFAULT_COOLDOWN_MS } from "@3kaiu/dsh-plugin-kit";
import { DEFAULT_CATALOG_REFRESH_MS } from "./catalog.ts";

const PROVIDER = "opencode-zen";
const NS = settingsNamespace("llm-opencode-zen");
const DEFAULT_API_KEY_ENV = "OPENCODE_ZEN_API_KEY";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 128000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
const DEFAULT_MAX_CONCURRENT_STREAMS = 2;

const OPENCODE_UA = "opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
const PUBLIC_BASE_URL = "https://opencode.ai/zen/v1";
const BASE_URL_ENV = "OPENCODE_ZEN_BASE_URL";

// baseURL 安全校验：适配器会把 Authorization 头与完整对话发往该地址，
// 任意主机值即构成凭据/对话外泄面（settings 与 env 双入口都可注入）。
// 策略：必须为合法 URL；仅允许 https（本地回环放行 http 便于开发代理）；
// 拒绝携带 userinfo（user:pass@）的 URL —— 凭据不得经由 URL 夹带。
export function assertSafeBaseURL(value) {
  const raw = String(value ?? "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`llm-opencode-zen: baseURL 不是合法 URL: ${JSON.stringify(raw.slice(0, 80))}`);
  }
  const host = parsed.hostname;
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error(`llm-opencode-zen: baseURL 仅允许 https（本地回环可 http），收到 ${parsed.protocol}//${host}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("llm-opencode-zen: baseURL 不得携带 userinfo（user:pass@）——凭据请走 credential-ref");
  }
  return raw;
}

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
  catalog: z.union(["auto", "custom"]),
  defaultModel: z.string(),
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
    baseURL: assertSafeBaseURL(config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? PUBLIC_BASE_URL),
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

export {
  PROVIDER,
  NS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_STREAMS,
  DEFAULT_RETRY_POLICY,
  PacingSchema,
  catalogModel,
  Config,
  PUBLIC_BASE_URL,
  BASE_URL_ENV,
  OPENCODE_UA,
  resolveModels,
  resolveAdapterOptions,
};
