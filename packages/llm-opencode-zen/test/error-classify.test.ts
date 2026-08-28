// 错误分类回归: 4xx JSON body 中的上下文超限/配额措辞必须按 dsh-llm 谓词正确分类。
// 此前 httpErrorCode 把解析出的 error 对象直接传给谓词（契约是字符串），
// RegExp.test("[object Object]") 永不命中，上下文超限被误分类为 PROVIDER_ERROR。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch } from "@3kaiu/dsh-plugin-kit";
process.env.DSH_QUOTA_FILE = join(tmpdir(), `dsh-quota-test-${process.pid}-${Date.now()}.json`);
const { OpenCodeZenAdapter } = await import("../dist/index.js");

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

// 1) OpenAI 风格 {error:{message}} + 上下文超限措辞 → CONTEXT_WINDOW_EXCEEDED
mockFetch(400, JSON.stringify({ error: { message: "This model's maximum context length is 40960 tokens. However, your messages resulted in 50000 tokens." } }));
let r = await run("t-ctx-1");
if (r.error?.code !== "CONTEXT_WINDOW_EXCEEDED") throw new Error(`error.message 上下文超限应映射为 CONTEXT_WINDOW_EXCEEDED, got ${r.error?.code}`);
console.log("✓ {error:{message}} 上下文超限 → CONTEXT_WINDOW_EXCEEDED");

// 2) 顶层 {message}（无 error 键）+ prompt too long 措辞 → CONTEXT_WINDOW_EXCEEDED
mockFetch(400, JSON.stringify({ message: "input is too long for the model" }));
r = await run("t-ctx-2");
if (r.error?.code !== "CONTEXT_WINDOW_EXCEEDED") throw new Error(`顶层 message 上下文超限应映射为 CONTEXT_WINDOW_EXCEEDED, got ${r.error?.code}`);
console.log("✓ 顶层 {message} 上下文超限 → CONTEXT_WINDOW_EXCEEDED");

// 3) 400 + 配额措辞（type 命中）→ QUOTA
mockFetch(400, JSON.stringify({ error: { type: "insufficient_quota", message: "check your plan" } }));
r = await run("t-quota-detail");
if (r.error?.code !== "QUOTA") throw new Error(`insufficient_quota 应映射为 QUOTA, got ${r.error?.code}`);
console.log("✓ error.type 配额措辞 → QUOTA");

// 4) 400 + 无关措辞 → PROVIDER_ERROR（不误伤）
mockFetch(400, JSON.stringify({ error: { message: "invalid request: unknown field" } }));
r = await run("t-plain-400");
if (r.error?.code !== "PROVIDER_ERROR") throw new Error(`无关 400 应保持 PROVIDER_ERROR, got ${r.error?.code}`);
console.log("✓ 无关 400 → PROVIDER_ERROR");

console.log("全部通过 ✓");
