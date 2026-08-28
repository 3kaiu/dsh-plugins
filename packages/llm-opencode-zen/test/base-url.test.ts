// baseURL 安全校验回归：适配器会把 Authorization 头与完整对话发往 baseURL，
// 任意主机值即构成凭据/对话外泄面。策略：https 强制（回环放行 http）、拒 userinfo。
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DSH_QUOTA_FILE = join(tmpdir(), `dsh-quota-test-${process.pid}-${Date.now()}.json`);
const { assertSafeBaseURL, OpenCodeZenAdapter } = await import("../dist/index.js");

let failures = 0;
const ok = (label, fn) => {
  try { fn(); console.log(`✓ ${label}`); }
  catch (e) { failures++; console.error(`✗ ${label}: ${e.message}`); }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// 1) 合法值放行
ok("https 正常放行", () => { if (assertSafeBaseURL("https://opencode.ai/zen/v1") !== "https://opencode.ai/zen/v1") throw new Error("值被改动"); });
ok("http 回环放行", () => assertSafeBaseURL("http://localhost:3080/v1"));
ok("http 127.0.0.1 放行", () => assertSafeBaseURL("http://127.0.0.1:1234"));

// 2) 危险值拒绝
ok("非回环 http 拒绝", () => { if (!throws(() => assertSafeBaseURL("http://evil.example.com"))) throw new Error("应拒绝"); });
ok("非 URL 拒绝", () => { if (!throws(() => assertSafeBaseURL("not-a-url"))) throw new Error("应拒绝"); });
ok("userinfo 拒绝", () => { if (!throws(() => assertSafeBaseURL("https://user:pass@opencode.ai/zen/v1"))) throw new Error("应拒绝"); });
ok("ftp 拒绝", () => { if (!throws(() => assertSafeBaseURL("ftp://opencode.ai"))) throw new Error("应拒绝"); });
ok("空值拒绝", () => { if (!throws(() => assertSafeBaseURL(""))) throw new Error("应拒绝"); });

// 3) 适配器请求路径：恶意 baseURL 在 fetch 之前即失败（不发起请求、不耗配额）
const opts = {
  baseURL: "http://evil.example.com",
  models: [],
  maxTokens: 100,
  defaultContextWindow: 100,
  streamIdleTimeoutMs: 5000,
  maxConcurrentStreams: 2,
  retryPolicy: { mode: "none" },
  defaults: { thinking: "enabled", reasoningEffort: "max" },
};
let fetchCalled = false;
global.fetch = async () => { fetchCalled = true; return { status: 200, ok: true, headers: new Map(), text: async () => "" }; };
const adapter = new OpenCodeZenAdapter(
  { options: () => opts, resolveApiKey: async () => "public" },
  { acquire: async () => {}, release: () => {} },
);
let rejected = false;
try {
  for await (const _ of adapter.stream({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    sessionId: "t-baseurl",
  })) {}
} catch (e) {
  rejected = /baseURL 仅允许 https/.test(String(e.message ?? e));
}
if (!rejected) throw new Error("恶意 baseURL 应在请求前拒绝");
if (fetchCalled) throw new Error("不得对恶意 baseURL 发起 fetch");
console.log("✓ 适配器请求前拦截，fetch 未被调用");

if (failures > 0) { console.error(`base-url 测试失败 ${failures} 项`); process.exit(1); }
console.log("base-url OK ✓");
