// 402/429 限流回归测试: 验证配额耗尽(QUOTA)与限流(RATE_LIMITED)路径的冷却与文案
import { OpenCodeZenAdapter, quota, resolveAdapterOptions } from "../dist/llm-opencode-zen.js";

const opts = {
  models: [],
  maxTokens: 100,
  defaultContextWindow: 100,
  streamIdleTimeoutMs: 5000,
  maxConcurrentStreams: 2,
  retryPolicy: { mode: "none" },
  defaults: { thinking: "enabled", reasoningEffort: "max" },
};
const adapter = new OpenCodeZenAdapter(
  { options: () => opts, resolveApiKey: async () => "public" },
  { acquire: async () => {}, release: () => {} },
);

function mockFetch(status, body, contentType = "application/json") {
  global.fetch = async () => ({
    status,
    ok: false,
    headers: new Map([["content-type", contentType]]),
    text: async () => body,
  });
}

async function run(sessionId) {
  try {
    for await (const _ of adapter.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      sessionId,
    })) {}
    return { error: null };
  } catch (e) {
    return { error: e };
  }
}

// 1) 402 JSON body -> QUOTA + 冷却 + 计数
mockFetch(402, JSON.stringify({ error: { message: "quota exhausted" } }));
let r = await run("t-402");
if (r.error?.code !== "QUOTA") throw new Error(`402 JSON 应映射为 QUOTA, got ${r.error?.code}`);
if (!r.error.message.includes("免费额度已耗尽")) throw new Error("402 缺中文文案");
if (quota.cooldownRemainingMs("t-402") <= 0) throw new Error("402 未记录冷却");
console.log("✓ 402 JSON body -> QUOTA + 冷却 + 文案");

// 2) 402 非 JSON body (HTML) 透出原文
mockFetch(402, "<html>Payment Required</html>", "text/html");
r = await run("t-402-html");
if (r.error?.code !== "QUOTA") throw new Error(`402 HTML 应映射为 QUOTA, got ${r.error?.code}`);
if (!r.error.message.includes("<html>")) throw new Error("非 JSON body 未透出原文");
console.log("✓ 402 HTML body 原文透出");

// 3) 429 -> RATE_LIMITED + 冷却
mockFetch(429, JSON.stringify({ error: { message: "Rate limit exceeded" } }));
r = await run("t-429");
if (r.error?.code !== "RATE_LIMITED") throw new Error(`429 应映射为 RATE_LIMITED, got ${r.error?.code}`);
if (!r.error.message.includes("限流")) throw new Error("429 缺限流文案");
if (quota.cooldownRemainingMs("t-429") <= 0) throw new Error("429 未记录冷却");
console.log("✓ 429 -> RATE_LIMITED + 冷却");

// 4) retryPolicy 应包含 QUOTA (允许外层重试整轮)
const resolved = resolveAdapterOptions({ thinking: "enabled", reasoningEffort: "max" }, { get: () => undefined });
if (!resolved.retryPolicy.retryableCodes.includes("QUOTA"))
  throw new Error("retryPolicy 应包含 QUOTA");
console.log("✓ retryPolicy 包含 QUOTA");

console.log("全部通过 ✓");