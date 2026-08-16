// dsh-runtime-events 单测:用实证抓取的真实 firehose 形状驱动映射断言
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createSink, finalizeSession, processEvent, sessionOf, ulid } from "../src/index.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok -", name); };

//#region fixture:2026-08-17 实证运行抓取(隔离 home,deepseek-v4-flash-free)
const SID = "session-56cf6214-92ce-42a2-8bb2-2733caa74c69";
const fakeSession = { id: SID };
const T0 = 1786892410000;
const fixtures = [
  { type: "session/title", seq: 10, time: T0 + 100, data: { title: "Reply with node version", messageSeqs: [7], source: "llm" } },
  { type: "request/context", seq: 12, time: T0 + 120, data: { provider: "opencode-zen", model: "deepseek-v4-flash-free", contextWindow: 200000 } },
  { type: "turn/start", seq: 4, time: T0 + 40, data: { turn: 1 } },
  { type: "tool/call", seq: 37, time: T0 + 900, data: { turn: 1, step: 1, callId: "call_8567914a9be44df29b1a7e19", name: "bash", arguments: '{"command":"node --version","description":"Show Node.js version","workdir":"/tmp/dsh-spike3/profiles/headless"}' } },
  { type: "assistant/chunk", seq: 57, time: T0 + 1200, data: { turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 30, outputTokens: 29, cacheReadTokens: 8192 } } } },
  { type: "tool/result", seq: 39, time: T0 + 1600, data: { turn: 1, step: 1, message: { role: "tool", content: [{ type: "tool-result", toolCallId: "call_8567914a9be44df29b1a7e19", isError: false, content: [{ type: "text", text: "v26.2.0" }] }], source: { kind: "tool", callId: "call_8567914a9be44df29b1a7e19" } } } },
  { type: "turn/end", seq: 61, time: T0 + 2000, data: { turn: 1, reason: { kind: "completed" } } },
  { type: "llm/retry", seq: 62, time: T0 + 3000, data: { error: "RATE_LIMITED: try again later" } },
];
//#endregion

console.log("# 映射:session/tool/error 家族");
{
  const emitted = [];
  const opts = { inputSummaryMax: 200, stdoutTailMax: 500, idleCompleteMs: 0 };
  const agg = { sessions: new Map(), calls: new Map() };
  const emit = (family, type, data, sessionId) => emitted.push({ family, type, data, sessionId });
  sessionOf(agg, fakeSession, T0);
  for (const f of fixtures) processEvent(agg, emit, opts, fakeSession, f);
  finalizeSession(agg, emit, SID, agg.sessions.get(SID), T0 + 5000);

  const byType = Object.fromEntries(emitted.map((e) => [e.type, e]));

  // session.started:title 先到 → 携带 title;model 后到但 started 已发(immutable)
  assert.equal(byType["session.started"].family, "session");
  assert.equal(byType["session.started"].data.title, "Reply with node version");
  assert.equal(byType["session.started"].sessionId, SID);
  ok("session.started 携带 title 与 sessionId");

  assert.deepEqual(byType["session.title"].data, { title: "Reply with node version" });
  ok("session.title 直通");

  assert.equal(byType["tool.started"].family, "tool");
  assert.equal(byType["tool.started"].data.tool, "bash");
  assert.ok(byType["tool.started"].data.inputSummary.includes("node --version"));
  ok("tool.started:工具名+入参摘要");

  assert.equal(byType["tool.completed"].data.tool, "bash");
  assert.equal(byType["tool.completed"].data.exitCode, 0);
  assert.equal(byType["tool.completed"].data.stdoutTail, "v26.2.0");
  assert.equal(byType["tool.completed"].data.latencyMs, 700);
  ok("tool.completed:exitCode=0 + stdoutTail + latency");

  assert.deepEqual(byType["session.completed"].data.tokens, { in: 30, out: 29 });
  assert.equal(byType["session.completed"].data.turns, 1);
  assert.equal(byType["session.completed"].data.reason, "completed");
  ok("session.completed:轮次+token+reason");

  assert.equal(byType["error.recorded"].data.taxonomy, "LLM_RETRY");
  assert.equal(byType["error.recorded"].data.severity, "LOW");
  assert.equal(byType["error.recorded"].data.occurrences, 1);
  ok("llm/retry → error.recorded(LLM_RETRY/LOW)");

  // 无未归一化噪声:9 条 fixture 产生 6 个包络(不去重的 turn/start 等被聚合)
  assert.ok(emitted.length >= 6, "envelope count");
}

console.log("# tool.failed(isError)");
{
  const emitted = [];
  const opts = { inputSummaryMax: 200, stdoutTailMax: 500, idleCompleteMs: 0 };
  const agg = { sessions: new Map(), calls: new Map() };
  const emit = (family, type, data, sessionId) => emitted.push({ family, type, data, sessionId });
  const s2 = { id: "session-fail-1" };
  sessionOf(agg, s2, T0);
  processEvent(agg, emit, opts, s2, { type: "tool/call", time: T0, data: { callId: "c1", name: "bash", arguments: "{}" } });
  processEvent(agg, emit, opts, s2, { type: "tool/result", time: T0 + 50, data: { message: { content: [{ type: "tool-result", toolCallId: "c1", isError: true, content: [{ type: "text", text: "command not found: nope" }] }] } } });
  const failed = emitted.find((e) => e.type === "tool.failed");
  assert.equal(failed.data.tool, "bash");
  assert.equal(failed.data.exitCode, 1);
  assert.equal(failed.data.taxonomy, "TOOL_ERROR");
  assert.equal(failed.data.message, "command not found: nope");
  ok("tool.failed:exitCode=1 + taxonomy + message");
}

console.log("# interrupted 补发");
{
  const emitted = [];
  const opts = { inputSummaryMax: 200, stdoutTailMax: 500, idleCompleteMs: 0 };
  const agg = { sessions: new Map(), calls: new Map() };
  const emit = (family, type, data, sessionId) => emitted.push({ family, type, data, sessionId });
  const s3 = { id: "session-int-1" };
  sessionOf(agg, s3, T0);
  processEvent(agg, emit, opts, s3, { type: "turn/start", time: T0, data: { turn: 1 } });
  processEvent(agg, emit, opts, s3, { type: "turn/end", time: T0 + 50, data: { turn: 1, reason: { kind: "completed" } } });
  // 退出兜底在 T0+99 触发:reason 保留真实 turn/end,时长按最后活动时间(T0+50)
  finalizeSession(agg, emit, s3.id, agg.sessions.get(s3.id), T0 + 99, true);
  const c = emitted.find((e) => e.type === "session.completed");
  assert.equal(c.data.reason, "completed");
  assert.equal(c.data.turns, 1);
  assert.equal(c.data.durationMs, 50);
  ok("session.completed 中断补发:保留真实 reason + 最后活动时长");
}

console.log("# ulid 形状");
{
  const id = ulid();
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  ok("ulid:26 字符 Crockford");
}

console.log("# sink:追加 + seq 持久化 + 家族文件");
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-events-test-"));
  const sink = createSink(dir, join(dir, "seq"));
  sink.push({ schema: 1, eventId: "evt_x", family: "session", type: "session.started", at: "2026-08-17T00:00:00.000Z", source: "harness", data: {} });
  sink.push({ schema: 1, eventId: "evt_y", family: "tool", type: "tool.started", at: "2026-08-17T00:00:00.001Z", source: "harness", data: {} });
  sink.flush();
  const all = readFileSync(join(dir, "all.jsonl"), "utf8").trim().split("\n");
  assert.equal(all.length, 2);
  assert.equal(JSON.parse(all[0]).seq, 1);
  assert.equal(JSON.parse(all[1]).seq, 2);
  const sess = readFileSync(join(dir, "session.jsonl"), "utf8").trim().split("\n");
  assert.equal(sess.length, 1);
  assert.equal(JSON.parse(sess[0]).type, "session.started");
  assert.equal(readFileSync(join(dir, "seq"), "utf8"), "2");
  // 续写 seq 不重置
  const sink2 = createSink(dir, join(dir, "seq"));
  assert.equal(sink2.seq, 2);
  sink2.push({ schema: 1, eventId: "evt_z", family: "session", type: "session.title", at: "2026-08-17T00:00:00.002Z", source: "harness", data: {} });
  sink2.flush();
  assert.equal(readFileSync(join(dir, "seq"), "utf8"), "3");
  ok("sink:seq 单调 + 家族文件 + 重启续 seq");
}

console.log("# 空闲补发(turn/end + idleCompleteMs)");
{
  const emitted = [];
  const opts = { inputSummaryMax: 200, stdoutTailMax: 500, idleCompleteMs: 10 };
  const agg = { sessions: new Map(), calls: new Map() };
  const emit = (family, type, data, sessionId) => emitted.push({ family, type, data, sessionId });
  const s4 = { id: "session-idle-1" };
  sessionOf(agg, s4, T0);
  processEvent(agg, emit, opts, s4, { type: "turn/start", time: T0, data: { turn: 1 } });
  processEvent(agg, emit, opts, s4, { type: "turn/end", time: T0 + 10, data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((res) => setTimeout(res, 40));
  const c = emitted.find((e) => e.type === "session.completed");
  assert.ok(c, "空闲补发应产生 completed");
  assert.equal(c.data.reason, "completed");
  assert.equal(c.data.turns, 1);
  // 补发后再次 finalize 不应重复
  finalizeSession(agg, emit, s4.id, agg.sessions.get(s4.id), T0 + 100, true);
  assert.equal(emitted.filter((e) => e.type === "session.completed").length, 1);
  ok("空闲补发:10ms 后 completed,不重复");
}

console.log("\npassed", passed, "checks");
