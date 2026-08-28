// 动态免费模型目录回归测试:
// 1) auto 模式 = models.dev 免费元数据 ∩ live /v1/models,deprecated 沉底,defaultModel 置顶
// 2) contextWindow/maxTokens 取自 models.dev limit
// 3) 拉取失败回退静态目录 + warn 告警
// 4) reasoning:false 的免费模型请求时强制 effort=off
// 5) custom 模式零网络,直接用静态目录
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DSH_QUOTA_FILE = join(tmpdir(), `dsh-catalog-test-${process.pid}-${Date.now()}.json`);
const { OpenCodeZenAdapter, resetCatalogCache, resolveAdapterOptions } = await import("../dist/index.js");

resetCatalogCache();

const MODELS_DEV = {
  opencode: {
    api: "https://opencode.ai/zen/v1",
    models: {
      "m-free-a": { name: "Free A", description: "free model a", limit: { context: 100000, output: 32000 }, cost: { input: 0, output: 0 }, tool_call: true, reasoning: true },
      "m-free-noreason": { name: "No Reason", limit: { context: 50000, output: 8000 }, cost: { input: 0, output: 0 }, tool_call: true, reasoning: false },
      "m-paid": { name: "Paid", limit: { context: 200000, output: 64000 }, cost: { input: 1, output: 2 } },
      "m-free-deprecated": { name: "Old Free", status: "deprecated", limit: { context: 80000, output: 16000 }, cost: { input: 0, output: 0 } },
      "m-free-offline": { name: "Gone Free", cost: { input: 0, output: 0 } },
    },
  },
};
const LIVE_IDS = ["m-free-a", "m-free-noreason", "m-paid", "m-free-deprecated"];

function jsonResponse(body) {
  return { ok: true, status: 200, headers: new Map(), json: async () => body };
}

let catalogFetches = 0;
function mockCatalogFetch({ failLive = false } = {}) {
  global.fetch = async (url) => {
    if (String(url).endsWith("/models")) {
      if (failLive) throw new Error("network down");
      catalogFetches += 1;
      return jsonResponse({ object: "list", data: LIVE_IDS.map((id) => ({ id, object: "model" })) });
    }
    return jsonResponse(MODELS_DEV);
  };
}

function makeAdapter(opts) {
  const warnings = [];
  const adapter = new OpenCodeZenAdapter(
    {
      options: () => resolveAdapterOptions(opts, { get: () => undefined }),
      resolveApiKey: async () => "public",
      warn: (message) => warnings.push(message),
    },
    { acquire: async () => {}, release: () => {} },
  );
  return { adapter, warnings };
}

const BASE_OPTS = {
  baseURL: "https://zen.test/v1",
  apiKeyEnv: "OPENCODE_ZEN_API_KEY",
  thinking: "enabled",
  reasoningEffort: "max",
  maxTokens: 4096,
  defaultContextWindow: 8192,
  streamIdleTimeoutMs: 5000,
  maxConcurrentStreams: 2,
};

// 1) auto 目录:交集过滤 + deprecated 沉底 + defaultModel 置顶 + limit 映射
mockCatalogFetch();
{
  const { adapter } = makeAdapter({ ...BASE_OPTS, defaultModel: "m-free-noreason" });
  const models = await adapter.listModels("opencode-zen");
  const ids = models.map((m) => m.id);
  if (ids.includes("m-paid")) throw new Error("付费模型不应出现在免费目录");
  if (ids.includes("m-free-offline")) throw new Error("live 端点已下线的模型不应出现");
  if (ids[0] !== "m-free-noreason") throw new Error(`defaultModel 应置顶, got ${ids[0]}`);
  if (ids[ids.length - 1] !== "m-free-deprecated") throw new Error(`deprecated 应回到最后, got ${ids.join(",")}`);
  const a = models.find((m) => m.id === "m-free-a");
  if (a.name !== "Free A" || a.description !== "free model a") throw new Error("name/description 未映射");
  console.log("✓ auto 目录 = models.dev 免费 ∩ live 在服;defaultModel 置顶 / deprecated 沉底");
}

// 2) 缓存生效:TTL 内不重复拉源
await (await import("../dist/index.js")).OpenCodeZenAdapter.prototype.listModels.call(
  makeAdapter({ ...BASE_OPTS }).adapter, "opencode-zen",
);
if (catalogFetches !== 1) throw new Error(`TTL 内应命中缓存, live 拉取 ${catalogFetches} 次`);
console.log("✓ 目录 TTL 缓存生效(第二次 listModels 零网络)");

// 3) resolveModel:目录内命中 limit;目录外回退默认值
{
  const { adapter } = makeAdapter(BASE_OPTS);
  const inside = await adapter.resolveModel("opencode-zen", "m-free-a");
  if (inside.context.contextWindow !== 100000 || inside.defaultMaxTokens !== 32000)
    throw new Error("resolveModel 未用目录内 limit");
  const outside = await adapter.resolveModel("opencode-zen", "unknown-model");
  if (outside.context.contextWindow !== 8192) throw new Error("未知模型应回退 defaultContextWindow");
  console.log("✓ resolveModel:目录内取 limit,未知模型回退默认值");
}

// 4) reasoning:false 模型 → wire 强制 effort=off
{
  mockCatalogFetch();
  resetCatalogCache();
  let captured;
  global.fetch = async (url, init) => {
    if (String(url).endsWith("/models") || String(url).includes("models.dev"))
      return jsonResponse(String(url).endsWith("/models") ? { object: "list", data: LIVE_IDS.map((id) => ({ id })) } : MODELS_DEV);
    captured = JSON.parse(init.body);
    return sseOk();
  };
  function sseOk() {
    const enc = new TextEncoder();
    return {
      status: 200, ok: true, headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: null, delta: { content: "ok" } }] })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      text: async () => "",
    };
  }
  const { adapter } = makeAdapter(BASE_OPTS);
  for await (const _ of adapter.stream({
    model: "m-free-noreason",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    sessionId: "t-noreason",
  })) {}
  if ("reasoning_effort" in captured) throw new Error(`reasoning:false 模型不应带 reasoning_effort: ${JSON.stringify(captured)}`);
  // 对照组:支持推理的模型保留全局档位
  captured = undefined;
  for await (const _ of adapter.stream({
    model: "m-free-a",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    sessionId: "t-reason",
  })) {}
  if (captured?.reasoning_effort !== "max") throw new Error(`正常模型应保留全局档位 max, got ${captured?.reasoning_effort}`);
  console.log("✓ reasoning:false 免费模型强制 effort=off,其余保留全局档位");
}

// 5) 拉取失败 → 回退静态目录 + warn 一次
{
  resetCatalogCache();
  mockCatalogFetch({ failLive: true });
  const staticModels = [{ id: "static-fallback", name: "Static", contextWindow: 12345, maxTokens: 999 }];
  const { adapter, warnings } = makeAdapter({ ...BASE_OPTS, catalog: "custom", models: staticModels });
  // custom 不打网络:即便 fetch 全坏也直接拿静态目录
  const models = await adapter.listModels("opencode-zen");
  if (models.length !== 1 || models[0].id !== "static-fallback") throw new Error("custom 模式应直接返回静态目录");
  if (warnings.length !== 0) throw new Error("custom 模式不应告警");
  console.log("✓ custom 模式零网络直用静态目录");
}

// 6) auto 失败告警文案存在(负缓存后快速失败)
{
  resetCatalogCache();
  global.fetch = async () => { throw new Error("offline"); };
  const { adapter, warnings } = makeAdapter({ ...BASE_OPTS, models: [] });
  const models = await adapter.listModels("opencode-zen");
  if (models.length !== 0) throw new Error("auto 失败且无静态目录时应返回空目录");
  if (!warnings.some((w) => w.includes("免费模型目录拉取失败"))) throw new Error(`缺回退告警: ${JSON.stringify(warnings)}`);
  console.log("✓ auto 拉取失败回退静态目录并告警一次");
}

resetCatalogCache();
console.log("全部通过 ✓");
