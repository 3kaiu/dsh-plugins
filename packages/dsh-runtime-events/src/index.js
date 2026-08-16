// @3kaiu/dsh-runtime-events —— 运行时事件桥
// 把官方 session firehose(session/event + created/disposed)归一化为 09 篇
// 协议的五族事件(session/tool/error/test/completion),追加写入
// DSH_HOME/state/events/{family}.jsonl + all.jsonl,seq 持久化于 events/seq。
// test/completion 两族由 GitHub 侧(source=github)填充,本插件保留族名。
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

const DSH_HOME = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const NS = settingsNamespace("runtime-events");
const FAMILIES = ["session", "tool", "error", "test", "completion"];

//#region ulid(迷你实现:10 字符时间前缀 + 16 字符随机,26 字符 Crockford base32)
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid() {
  let t = BigInt(Date.now());
  const timePart = [];
  for (let i = 0; i < 10; i++) {
    timePart.unshift(CROCKFORD[Number(t & 31n)]);
    t >>= 5n;
  }
  const rand = randomBytes(16);
  let randPart = "";
  for (let i = 0; i < 16; i++) randPart += CROCKFORD[rand[i] & 31];
  return timePart.join("") + randPart;
}
//#endregion

//#region 配置
const Config = z.object({
  enabled: z.boolean().default(true),
  eventsDir: z.string().default(join(DSH_HOME, "state", "events")),
  usagePollMs: z.number().min(1000).max(3600000).default(5000),
  inputSummaryMax: z.number().min(0).default(200),
  stdoutTailMax: z.number().min(0).default(500),
  idleCompleteMs: z.number().min(0).default(10000),
  usageFile: z.string().default(join(DSH_HOME, "storages", "llm-opencode-zen-usage.json")),
});
//#endregion

//#region 纯逻辑(可单测)
/** 追加式事件库:seq 单调递增,每包络写 all.jsonl + 家族文件。 */
function createSink(eventsDir, seqFile) {
  let seq = existsSync(seqFile) ? Number(readFileSync(seqFile, "utf8")) || 0 : 0;
  return {
    get seq() { return seq; },
    push(envelope) {
      seq += 1;
      const line = JSON.stringify({ seq, ...envelope }) + "\n";
      appendFileSync(join(eventsDir, "all.jsonl"), line, "utf8");
      appendFileSync(join(eventsDir, envelope.family + ".jsonl"), line, "utf8");
    },
    flush() { writeFileSync(seqFile, String(seq), "utf8"); },
  };
}

/** 会话聚合状态。 */
function sessionOf(aggregate, session, now = Date.now()) {
  let st = aggregate.sessions.get(session.id);
  if (st === void 0) {
    st = { createdAt: now, lastActivityAt: now, turns: 0, title: void 0, model: void 0, provider: void 0, reason: void 0, tokens: { in: 0, out: 0 }, started: false, completed: false };
    aggregate.sessions.set(session.id, st);
  }
  return st;
}

function maybeStarted(aggregate, emit, sid, st) {
  if (st.started) return;
  st.started = true;
  emit("session", "session.started", {
    ...(st.title !== void 0 ? { title: st.title } : {}),
    ...(st.model !== void 0 ? { model: st.model } : {}),
    ...(st.provider !== void 0 ? { provider: st.provider } : {}),
  }, sid);
}

/** 处理一条 firehose 事件(官方 session/event 载荷) → 归一化事件。 */
function processEvent(aggregate, emit, opts, session, event) {
  const sid = session.id;
  const st = sessionOf(aggregate, session, event.time);
  st.lastActivityAt = Math.max(st.lastActivityAt ?? st.createdAt, event.time);
  const d = event.data ?? {};
  switch (event.type) {
    case "request/context":
      st.model = d.model;
      st.provider = d.provider;
      maybeStarted(aggregate, emit, sid, st);
      break;
    case "session/title":
      st.title = d.title;
      maybeStarted(aggregate, emit, sid, st);
      emit("session", "session.title", { title: d.title }, sid);
      break;
    case "turn/start":
      st.turns += 1;
      if (st.pendingComplete !== void 0) { clearTimeout(st.pendingComplete); st.pendingComplete = void 0; }
      break;
    case "turn/end":
      st.reason = d.reason?.kind ?? "completed";
      // headless 单轮会话:进程退出前会有长 quiescence 等待(实测 ~4 分钟);
      // turn/end 后空闲 10s 即视为会话完成,立即补发(续轮会取消)。
      if (opts.idleCompleteMs > 0 && !st.completed) {
        if (st.pendingComplete !== void 0) clearTimeout(st.pendingComplete);
        st.pendingComplete = setTimeout(() => {
          st.pendingComplete = void 0;
          finalizeSession(aggregate, emit, sid, st, Date.now());
        }, opts.idleCompleteMs);
      }
      break;
    case "assistant/chunk": {
      const chunk = d.chunk ?? {};
      if (chunk.type === "usage" && chunk.usage) {
        st.tokens.in += chunk.usage.inputTokens ?? 0;
        st.tokens.out += chunk.usage.outputTokens ?? 0;
      }
      break;
    }
    case "tool/call":
      aggregate.calls.set(d.callId, { tool: d.name, at: event.time });
      emit("tool", "tool.started", {
        tool: d.name,
        inputSummary: String(d.arguments ?? "").slice(0, opts.inputSummaryMax),
      }, sid);
      break;
    case "tool/result": {
      const msg = d.message ?? {};
      const tr = (msg.content ?? []).find((c) => c.type === "tool-result");
      const text = (tr?.content ?? []).map((c) => c.text ?? "").join("");
      const callId = d.callId ?? tr?.toolCallId;
      const call = aggregate.calls.get(callId) ?? { tool: "unknown", at: event.time };
      const isError = tr?.isError === true;
      const latencyMs = Math.max(0, event.time - (call.at ?? event.time));
      if (isError) {
        emit("tool", "tool.failed", {
          tool: call.tool,
          exitCode: 1,
          taxonomy: "TOOL_ERROR",
          message: text.slice(0, opts.stdoutTailMax) || "tool failed",
        }, sid);
      } else {
        emit("tool", "tool.completed", {
          tool: call.tool,
          exitCode: 0,
          latencyMs,
          stdoutTail: text.slice(0, opts.stdoutTailMax),
        }, sid);
      }
      break;
    }
    case "llm/retry":
      emit("error", "error.recorded", {
        taxonomy: "LLM_RETRY",
        severity: "LOW",
        message: String(d.error ?? "llm retry"),
        occurrences: 1,
      }, sid);
      break;
    default:
      break;
  }
}

/** 会话销毁/进程退出 → session.completed。 */
function finalizeSession(aggregate, emit, sid, st, now = Date.now(), interrupted = false) {
  if (st.completed) return;
  st.completed = true;
  if (st.pendingComplete !== void 0) { clearTimeout(st.pendingComplete); st.pendingComplete = void 0; }
  maybeStarted(aggregate, emit, sid, st);
  // 中断兜底时用最后活动时间计时长(进程退出时间会被 quiescence 等待期拉长);
  // reason 优先取最后一个 turn/end 的真实结果,而非一律 "interrupted"。
  const lastActive = st.lastActivityAt ?? st.createdAt;
  emit("session", "session.completed", {
    turns: st.turns,
    durationMs: Math.max(0, (interrupted ? lastActive : now) - st.createdAt),
    tokens: { in: st.tokens.in, out: st.tokens.out },
    ...(st.reason !== void 0
      ? { reason: st.reason }
      : interrupted ? { reason: "interrupted" } : {}),
  }, sid);
}
//#endregion

const name = "dsh-runtime-events";

function apply(ctx, config) {
  let lastGood;
  let current = () => {
    try {
      const next = Config(config ?? {});
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      ctx.logger?.error("dsh-runtime-events: keeping the last good configuration");
      ctx.logger?.error(error);
      return lastGood;
    }
  };
  const opts = current();
  if (!opts.enabled) return;

  const eventsDir = opts.eventsDir;
  mkdirSync(eventsDir, { recursive: true });
  const sink = createSink(eventsDir, join(eventsDir, "seq"));
  const aggregate = { sessions: new Map(), calls: new Map() };

  const emit = (family, type, data, sessionId) => {
    sink.push({
      schema: 1,
      eventId: "evt_" + ulid(),
      family,
      type,
      at: new Date().toISOString(),
      ...(sessionId !== void 0 ? { sessionId } : {}),
      source: "harness",
      data,
    });
    // 周期性落 seq:headless 进程可能随时被退出,降低丢失窗口
    if (sink.seq % 25 === 0) sink.flush();
  };

  const finalizeAll = (interrupted) => {
    for (const [sid, st] of aggregate.sessions) finalizeSession(aggregate, emit, sid, st, Date.now(), interrupted);
    sink.flush();
  };

  ctx.on("session/created", (session) => {
    sessionOf(aggregate, session);
  });
  ctx.on("session/event", (session, event) => {
    processEvent(aggregate, emit, current(), session, event);
  });
  ctx.on("session/disposed", (session) => {
    const st = aggregate.sessions.get(session.id);
    if (st !== void 0) finalizeSession(aggregate, emit, session.id, st);
  });

  // 用量文件增量 → error.recorded(免费层限流/额度)
  const readUsage = () => {
    try {
      if (!existsSync(opts.usageFile)) return null;
      return JSON.parse(readFileSync(opts.usageFile, "utf8"));
    } catch {
      return null;
    }
  };
  let lastUsage = readUsage();
  const timer = setInterval(() => {
    const u = readUsage();
    if (u === null || lastUsage === null) { lastUsage = u; return; }
    const dr = (u.rateLimited ?? 0) - (lastUsage.rateLimited ?? 0);
    const dq = (u.quotaExceeded ?? 0) - (lastUsage.quotaExceeded ?? 0);
    if (dr > 0) emit("error", "error.recorded", { taxonomy: "RATE_LIMITED", severity: "LOW", message: "rate limited requests increased", occurrences: dr });
    if (dq > 0) emit("error", "error.recorded", { taxonomy: "QUOTA_EXCEEDED", severity: "MEDIUM", message: "quota exceeded requests increased", occurrences: dq });
    lastUsage = u;
  }, opts.usagePollMs);

  ctx.on("dispose", () => {
    clearInterval(timer);
    finalizeAll(true);
  });
  // headless 等一次性模式直接走 process exit,不触发 cordis dispose;
  // 同步写保证退出前完成补发与 seq 落盘。
  process.once("exit", () => {
    clearInterval(timer);
    finalizeAll(true);
  });

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { config = source; },
  });
}

export { Config, FAMILIES, apply, createSink, finalizeSession, name, processEvent, sessionOf, ulid };
