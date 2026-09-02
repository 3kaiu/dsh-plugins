import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { QuotaTracker, Semaphore, sessionKeyOf, DEFAULT_COOLDOWN_MS } from "@3kaiu/dsh-plugin-kit";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  assertUsableApiKey,
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection } from "@deepseek-ai/dsh-settings";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { serializeMessages, serializeTools, buildWireRequest, resolveThinking } from "./serialize.ts";
import {
  parseSse,
  translate,
  repairToolArguments,
  estimateUsage,
  STREAM_IDLE_TIMEOUT_CODE,
  MAX_REQUEST_ATTEMPTS,
} from "./sse.ts";
import {
  freeModelCatalog,
  orderCatalog,
  resetCatalogCache,
  MODELS_DEV_URL,
  MODELS_DEV_PROVIDER,
  DEFAULT_CATALOG_REFRESH_MS,
} from "./catalog.ts";
import {
  PROVIDER,
  NS,
  DEFAULT_API_KEY_ENV,
  Config,
  PUBLIC_BASE_URL,
  BASE_URL_ENV,
  OPENCODE_UA,
  resolveAdapterOptions, assertSafeBaseURL } from "./config.ts";

//#region telemetry
const DSH_HOME = process.env.DSH_HOME!?.length > 0 ? process.env.DSH_HOME! : join(homedir(), ".dsh");
// DSH_QUOTA_FILE 可覆盖 usage 文件路径(测试隔离 / 多实例部署)
const QUOTA_FILE =
  process.env.DSH_QUOTA_FILE!?.length > 0 ? process.env.DSH_QUOTA_FILE! : join(DSH_HOME!, "storages", "llm-opencode-zen-usage.json");

const quota = new QuotaTracker(QUOTA_FILE);


//#endregion

//#region adapter
function providerRetryAfterMs(header: any) {
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
// ⚠️ 脆弱性声明: 见 config.ts 的 OPENCODE_UA 定义；此处复用导入的常量。

function formatDuration(ms: any, locale = "zh") {
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

function rateLimitMessage(ms: any, locale: any, apiKeyEnv: any) {
  const wait = formatDuration(ms, locale);
  if (locale === "en") {
    return `OpenCode Zen free quota exhausted; rate-limited for about ${wait}. Set env ${apiKeyEnv} for a higher quota.`;
  }
  return `OpenCode Zen 免费额度已用尽，当前处于限流状态，约 ${wait} 后可恢复使用；如需更高额度，可设置环境变量 ${apiKeyEnv}`;
}

function requestId(headers: any) {
  const value = headers.get("x-request-id") ?? headers.get("x-opencode-request-id");
  return value === null || value === void 0 || value.length === 0 ? void 0 : ProviderRequestId(value);
}

function httpErrorCode(status: any, error: any) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_ERROR";
  if (isContextWindowExceededError(error)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (isQuotaExceededError(error)) return QUOTA_EXCEEDED_CODE;
  return "PROVIDER_ERROR";
}

// dsh-llm 错误谓词契约：入参是"provider error 的 code/type/message 拼接成的一个字符串"。
// 这里把解析出的 JSON error 对象摊平成该字符串；直接传对象会让 RegExp.test
// 永远命中 "[object Object]"，上下文超限等错误将被误分类为 PROVIDER_ERROR。
function providerErrorDetail(error: any) {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  return [error.code, error.type, error.message].filter((v) => v != null).join(" ");
}

function opencodeHeaders(sessionId: any, userAgent: any, projectId: any) {
  return {
    "user-agent": userAgent,
    "x-opencode-client": "cli",
    "x-opencode-project": projectId,
    "x-opencode-session": sessionKeyOf(sessionId, projectId),
    "x-opencode-request": `msg_${randomBytes(12).toString("base64url")}`,
  };
}

function estimateInputText(messages: any) {
  return messages.map((message: any) => [
    typeof message.content === "string" ? message.content : "",
    message.reasoning_content ?? "",
    ...(message.tool_calls ?? []).map((call: any) => call.function?.arguments ?? ""),
  ].join("")).join("\n");
}

function modelInfo(provider: any, model: any) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === void 0 ? {} : { description: model.description },
    inputModalities: ["text" as const]
  };
}

class OpenCodeZenAdapter extends LlmAdapter {
  config;
  semaphore;
  constructor(config: any, semaphore: any) {
    super();
    this.config = config;
    this.semaphore = semaphore;
  }

  providerRetryPolicy(_provider: any) {
    return this.config.options().retryPolicy;
  }

  // 解析当前生效的模型目录:custom = 配置的静态目录;auto = 动态拉取免费模型,
  // 拉取失败(离线/源不可用)时回退到静态目录并告警一次。
  async catalogModels(settings: any) {
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

  async findModel(settings: any, modelId: any) {
    const models = await this.catalogModels(settings);
    return models.find((entry: any) => entry.id === modelId);
  }

  async listModels(provider: any) {
    const settings = this.config.options();
    const models = orderCatalog(await this.catalogModels(settings), settings.defaultModel);
    return Promise.resolve(models.map((model) => modelInfo(provider, model)));
  }

  // @ts-ignore - override with compatible any signature
  override async resolveModel(provider: any, model: any, _signal: any) {
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
        inputModalities: ["text" as const]
      } : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning,
    });
  }

  async *requestStream(options: any, connection: any, apiKey: any, payload: any, watchdog: any, effort: any, estimateInput: any) {
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
      let providerDetail = "";
      let rawBody = "";
      try {
        rawBody = await response.text();
      } catch {}
      try {
        const parsed = JSON.parse(rawBody);
        providerError = parsed?.error;
        if (providerError?.message) message = providerError.message;
        else if (parsed?.message) message = parsed.message;
        providerDetail = providerErrorDetail(providerError) || providerErrorDetail(parsed);
      } catch {
        // 非 JSON 响应体（如 HTML 错误页/纯文本）：透出原文，避免信息被吞
        const trimmed = typeof rawBody === "string" ? rawBody.trim() : "";
        if (trimmed.length > 0) message = trimmed.slice(0, 300);
      }
      const retryAfter = providerRetryAfterMs(response.headers.get("retry-after"));
      const reqId = requestId(response.headers);
      const code = httpErrorCode(response.status, providerDetail);
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
        ...reqId !== void 0 ? { requestId: reqId } : {},
      });
    }

    if (!response.body)
      throw new LlmError("OpenCode Zen API returned no response body", "EMPTY_RESPONSE");

    const chunks = parseSse(response.body, () => { watchdog.pulse(); });
    yield* translate(chunks, { estimateInput });
  }

  // @ts-ignore - override with compatible any signature
  override async *stream(options: any) {
    const settings = this.config.options();
    // 请求时再校验：settings 可被 replace 动态改写；未设时回退公共端点
    // （connection 后续用于 `${baseURL}/chat/completions` 拼接，undefined 会产生非法请求 URL）
    const effectiveBaseURL = assertSafeBaseURL(settings.baseURL ?? PUBLIC_BASE_URL);
    const connection = {
      baseURL: effectiveBaseURL,
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
      await new Promise<void>((resolve) => {
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
              quota.recordLimit(((error as any).failure?.providerRetryAfterMs), options.sessionId);
              throw error;
            }
            if (code === QUOTA_EXCEEDED_CODE) {
              // 402 = 免费额度耗尽（Payment Required）。同样记录冷却避免连续白打，
              // 让外层 retryPolicy 等待冷却后重试整轮。
              quota.recordLimit(((error as any).failure?.providerRetryAfterMs), options.sessionId);
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
let activeAdapter: any = null;

class ZenModelsGateway extends TypertRemoteService {
  constructor(ctx: any) {
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
  async applyFree(models: any) {
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
    // @ts-ignore - ctx is guaranteed to exist
    await this.ctx!!.get("settings").update(NS, {
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
function apply(ctx: any, config: any) {
  let current = () => config;
  let lastRaw: any;
  let lastGood: any;

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

  const resolveApiKey = async (connection: any) => {
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
    warn: (message: string, cause: any) => {
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
  buildWireRequest,
  assertSafeBaseURL,
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
