// GenerateOptions → wire 请求映射契约(官方 cookbook: "If the provider cannot honor a
// field, throw LlmError(..., 'UNSUPPORTED_OPTION') instead of silently dropping it")。
// 本适配器对契约内全部字段逐一透传;本测试锁住映射,防止未来改动引入静默丢弃。
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DSH_QUOTA_FILE = join(tmpdir(), `dsh-quota-test-${process.pid}-${Date.now()}.json`);
const { buildWireRequest } = await import("../dist/index.js");

const base = { model: "m1", purpose: "chat" };

// 1) temperature / stop / maxTokens 透传
let wire = JSON.parse(buildWireRequest([], { ...base, temperature: 0.3, stop: ["END"], maxTokens: 512 }, undefined, "off"));
if (wire.temperature !== 0.3) throw new Error("temperature 被丢弃");
if (JSON.stringify(wire.stop) !== '["END"]') throw new Error("stop 被丢弃");
if (wire.max_tokens !== 512) throw new Error("maxTokens 被丢弃");
console.log("✓ temperature/stop/maxTokens 透传");

// 2) stop 空数组 → 不带该键(而非 stop:[] 触发上游 4xx)
wire = JSON.parse(buildWireRequest([], { ...base, stop: [], maxTokens: 10 }, undefined, "off"));
if ("stop" in wire) throw new Error("空 stop 不应出现在 wire");
console.log("✓ 空 stop 省略");

// 3) system 消息置于首位(由 stream() 前置, 此处验证 messages 原样)
wire = JSON.parse(buildWireRequest([{ role: "system", content: "sys" }, { role: "user", content: "u" }], base, undefined, "off"));
if (wire.messages[0].content !== "sys" || wire.messages[1].content !== "u") throw new Error("messages 顺序被破坏");
console.log("✓ system/user 顺序保持");

// 4) tools → tools + tool_choice:auto; reasoning off → 无 reasoning_effort
const tools = [{ type: "function", function: { name: "f", parameters: {} } }];
wire = JSON.parse(buildWireRequest([], base, tools, "off"));
if (!wire.tools || wire.tool_choice !== "auto") throw new Error("tools 未透传");
if ("reasoning_effort" in wire) throw new Error("off 不应带 reasoning_effort");
console.log("✓ tools 透传 + effort off 省略");

// 5) session-title 的 64 token 钳制
wire = JSON.parse(buildWireRequest([], { ...base, purpose: "session-title", maxTokens: 999 }, undefined, "off"));
if (wire.max_tokens !== 64) throw new Error("session-title 未钳制到 64");
console.log("✓ session-title maxTokens 钳制");

// 6) reasoning on → reasoning_effort 透传
wire = JSON.parse(buildWireRequest([], base, undefined, "high"));
if (wire.reasoning_effort !== "high") throw new Error("reasoning_effort 被丢弃");
console.log("✓ reasoning_effort 透传");

console.log("全部通过 ✓");
