#!/usr/bin/env node
// dsh-maint —— 维护六工具(协议见 docs/09 §4,布局见 06 §4)+ 证据核验(Phase 2)
// 用法:
//   dsh-maint status [--json]                   列出维护事项(严重度×频率排序)
//   dsh-maint inspect <incidentId> [--json]     查看单个事项完整现场
//   dsh-maint reproduce <incidentId> [--json]   重放最小复现(退出 0=缺陷可复现)
//   dsh-maint test <incidentId> [--json]        跑定向测试(修复前后对比)
//   dsh-maint replay <traceRef> [--json]        深度回放:会话元数据+工具调用序列+错误+timeline
//   dsh-maint replay --before <ref> --after <ref> [--json]  修复前后行为对比
//   dsh-maint verify contract [--json]          契约闸门(diff 范围/禁止路径/行数)
//   dsh-maint verify evidence --claim <json> --incident <id> [--json]
//                                            证据核验:agent 声明 vs 磁盘事实
// 统一返回:{ ok, data, diagnostics }
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadIncidents, sortIncidents, findByPrefix, scoreOf } from "../lib/incidents.mjs";
import { loadContract, checkDiff } from "../lib/contract.mjs";
import { runCommand } from "../lib/run.mjs";

const REPO = resolve(process.env.DSH_MAINT_REPO ?? process.cwd());
const STATE = join(REPO, ".dsh", "state");
const KNOWLEDGE = join(REPO, ".dsh", "knowledge");

function out(ok, data, diagnostics = []) {
  console.log(JSON.stringify({ ok, data, diagnostics }, null, 2));
}
function fail(msg) { out(false, {}, [msg]); }

function readAttempts() {
  try {
    const p = join(STATE, "attempts.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function loadTrace(traceRef) {
  // traceRef 支持:仓库内 .dsh/state/traces/<ref>.jsonl、仓库内相对路径、绝对路径
  const candidates = [join(STATE, "traces", traceRef), join(REPO, traceRef), traceRef];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const events = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return { path: p, events };
  }
  return null;
}
function traceSummary(traceRef) {
  const t = loadTrace(traceRef);
  if (!t) return { exists: false, eventCount: 0 };
  const first = t.events[0], last = t.events[t.events.length - 1];
  return { exists: true, path: t.path, eventCount: t.events.length, firstType: first?.type ?? null, lastType: last?.type ?? null };
}
// 深度回放:把 trace 事件流还原为结构化会话(兼容五族包络与原始 firehose 两种形态)
function deepReplay(traceRef) {
  const t = loadTrace(traceRef);
  if (!t) return { exists: false };
  const ev = t.events;
  const at = (e) => (e.at ?? "").slice(11, 19) || "";
  const started = ev.find((e) => e.type === "session.started");
  const completed = ev.find((e) => e.type === "session.completed");
  const titleEv = ev.find((e) => e.type === "session.title");
  const ctx = ev.find((e) => e.type === "request/context");
  const calls = [];
  const errors = [];
  let retries = 0;
  let open = null;
  const timeline = [];
  const push = (e, msg) => timeline.push((at(e) ? at(e) + " " : "") + msg);
  for (const e of ev) {
    switch (e.type) {
      case "session.started": push(e, "session 开始" + (e.data.title ? " · " + e.data.title : "")); break;
      case "session.title": push(e, "会话标题: " + e.data.title); break;
      case "request/context": push(e, "请求上下文: " + (e.data.provider ?? "?") + " / " + (e.data.model ?? "?") + " (window " + (e.data.contextWindow ?? "?") + ")"); break;
      case "turn/start": push(e, "turn 开始"); break;
      case "turn/end": push(e, "turn 结束" + (e.data.reason ? " (" + e.data.reason.kind + ")" : "")); break;
      case "user/message": push(e, "用户消息"); break;
      case "tool.started": case "tool/call": open = { tool: e.data.tool ?? e.data.name ?? "?", input: e.data.inputSummary ?? (e.data.arguments ? String(e.data.arguments).slice(0, 120) : null), at: at(e) }; break;
      case "tool.completed": case "tool/result": {
        const d = e.data;
        const content = d.stdoutTail ?? (Array.isArray(d.message?.content) ? JSON.stringify(d.message.content).slice(0, 120) : null);
        const exit = d.exitCode ?? (d.isError ? 1 : 0);
        const c = { tool: open?.tool ?? d.tool ?? "?", input: open?.input ?? null, exitCode: exit, latencyMs: d.latencyMs ?? null, output: content ?? null, at: open?.at ?? at(e) };
        calls.push(c);
        timeline.push((c.at ? c.at + " " : "") + "→ " + c.tool + (c.input ? " " + String(c.input).replace(/\n/g, " ").slice(0, 60) : "") + (c.output != null ? " exit=" + c.exitCode + (c.latencyMs != null ? " (" + c.latencyMs + "ms)" : "") + " 「" + String(c.output).replace(/\n/g, " ").slice(0, 40) + "」" : " exit=" + c.exitCode));
        open = null;
        break;
      }
      case "tool.failed": {
        const c = { tool: open?.tool ?? e.data?.tool ?? "?", input: open?.input ?? null, exitCode: e.data?.exitCode ?? 1, error: e.data?.message ?? null, at: open?.at ?? at(e) };
        calls.push(c);
        timeline.push((c.at ? c.at + " " : "") + "→ " + c.tool + " ✗ " + (c.error ?? "").replace(/\n/g, " ").slice(0, 60));
        open = null;
        break;
      }
      case "llm/retry": retries++; push(e, "LLM 重试: " + (e.data.error ?? "").slice(0, 80)); break;
      case "error.recorded": errors.push({ taxonomy: e.data.taxonomy, severity: e.data.severity, occurrences: e.data.occurrences ?? 1 }); push(e, "错误: " + e.data.taxonomy + " (" + e.data.severity + " ×" + (e.data.occurrences ?? 1) + ")"); break;
      case "session.completed": push(e, "session 完成: " + (e.data.reason ?? "") + " turns=" + (e.data.turns ?? "?") + " tokens=" + (e.data.tokens ? e.data.tokens.in + "/" + e.data.tokens.out : "?")); break;
      default: if (e.type && !e.type.startsWith("assistant/") && e.type !== "message") push(e, e.type); break;
    }
  }
  return {
    exists: true, path: t.path, eventCount: ev.length,
    session: { title: titleEv?.data?.title ?? started?.data?.title ?? null, model: ctx?.data?.model ?? null, turns: completed?.data?.turns ?? null, tokens: completed?.data?.tokens ?? null, durationMs: completed?.data?.durationMs ?? null, reason: completed?.data?.reason ?? null },
    calls: calls.map((c) => ({ tool: c.tool, input: c.input, exitCode: c.exitCode, latencyMs: c.latencyMs, output: c.output ?? c.error })),
    errors, llmRetries: retries, timeline,
  };
}
// 修复前后对比:工具序列 + 错误 + 结果差异
function diffTraces(beforeRef, afterRef) {
  const a = deepReplay(beforeRef);
  const b = deepReplay(afterRef);
  if (!a.exists || !b.exists) return { exists: false, a: a.exists, b: b.exists };
  const seqA = a.calls.map((c) => c.tool);
  const seqB = b.calls.map((c) => c.tool);
  const changes = [];
  const n = Math.max(seqA.length, seqB.length);
  for (let i = 0; i < n; i++) {
    if (i >= seqA.length) changes.push({ at: i + 1, kind: "added", detail: "B 新增调用 " + seqB[i] });
    else if (i >= seqB.length) changes.push({ at: i + 1, kind: "removed", detail: "A 有而 B 无: " + seqA[i] });
    else if (seqA[i] !== seqB[i]) changes.push({ at: i + 1, kind: "changed", detail: seqA[i] + " → " + seqB[i] });
  }
  const resultChanges = [];
  for (let i = 0; i < Math.min(a.calls.length, b.calls.length); i++) {
    const ca = a.calls[i], cb = b.calls[i];
    if (ca.tool === cb.tool && ca.exitCode !== cb.exitCode) resultChanges.push({ at: i + 1, tool: ca.tool, exitCode: ca.exitCode + " → " + cb.exitCode });
  }
  const errA = a.errors.reduce((m, e) => m + (e.occurrences ?? 1), 0);
  const errB = b.errors.reduce((m, e) => m + (e.occurrences ?? 1), 0);
  return { exists: true, seqA, seqB, changes, resultChanges, errors: { before: a.errors, after: b.errors, total: errA + " → " + errB }, reason: { before: a.session.reason, after: b.session.reason }, sessionA: a.session, sessionB: b.session };
}

// 契约类闸门(contract):diff 范围 + 禁止路径 + 行数
function contractChecks(contract, diffBase) {
  const checks = [];
  let files = [];
  if (diffBase) {
    const r = runCommand("git diff --name-only " + diffBase, { cwd: REPO, timeoutMs: 30000 });
    files = r.stdout.split("\n").filter(Boolean);
    checks.push(...checkDiff(files, contract, REPO).checks);
    const r2 = runCommand("git diff --numstat " + diffBase, { cwd: REPO, timeoutMs: 30000 });
    let total = 0;
    for (const l of r2.stdout.split("\n")) {
      const m = l.match(/^(\d+)\s+(\d+)\s/);
      if (m) total += Number(m[1]) + Number(m[2]);
    }
    checks.push({ name: "max_diff_lines", result: total <= contract.budget.maxDiffLines ? "pass" : "fail", detail: total + "/" + contract.budget.maxDiffLines });
  } else {
    checks.push({ name: "no_forbidden_paths", result: "skip", detail: "未提供 diff 基准(DSH_MAINT_DIFF_BASE)" });
    checks.push({ name: "max_changed_files", result: "skip", detail: "未提供 diff 基准" });
    checks.push({ name: "max_diff_lines", result: "skip", detail: "未提供 diff 基准" });
  }
  return checks;
}

// 证据核验(evidence):agent 声明 vs 磁盘事实,防"假完成"
function evidenceChecks(claimPath, incidentId, contract, diffBase) {
  const checks = [];
  let c;
  try { c = JSON.parse(readFileSync(claimPath, "utf8")); }
  catch { return { checks: [{ name: "claim_parse", result: "fail", detail: "claim 文件无法解析" }] }; }
  const summaryOk = c.summary && String(c.summary).trim().length > 0;
  checks.push({ name: "summary_present", result: summaryOk ? "pass" : "fail", detail: summaryOk ? c.summary.slice(0, 120) : "(空)" });
  const filesOk = Array.isArray(c.changedFiles) && c.changedFiles.length > 0;
  checks.push({ name: "claim_changed_files", result: filesOk ? "pass" : "fail", detail: filesOk ? c.changedFiles.length + " 个文件" : "(非数组/空)" });
  const inc = findByPrefix(loadIncidents(REPO), incidentId);
  if (!inc) return { checks: [...checks, { name: "incident_lookup", result: "fail", detail: "未找到事项 " + incidentId }] };
  if (diffBase) {
    const r = runCommand("git diff --name-only " + diffBase, { cwd: REPO, timeoutMs: 30000 });
    const actual = r.stdout.split("\n").filter(Boolean);
    const claimed = c.changedFiles ?? [];
    const missing = claimed.filter((f) => !actual.includes(f));
    checks.push({ name: "claimed_files_in_diff", result: missing.length === 0 ? "pass" : "fail", detail: missing.length ? "声明但不在 diff: " + missing.join(", ") : "全部声明文件均真实修改" });
    const extra = actual.filter((f) => !claimed.includes(f));
    if (extra.length) checks.push({ name: "undisclosed_files_in_diff", result: "fail", detail: "diff 中未声明文件: " + extra.join(", ") });
    checks.push(...checkDiff(actual, contract, REPO).checks);
  } else {
    checks.push({ name: "claimed_files_in_diff", result: "skip", detail: "未提供 diff 基准(DSH_MAINT_DIFF_BASE)" });
  }
  const repCmd = inc.reproduce?.command;
  if (repCmd) {
    const rep = runCommand(repCmd, { cwd: inc.reproduce.workdir ? resolve(REPO, inc.reproduce.workdir) : REPO, timeoutMs: 120000 });
    checks.push({ name: "reproduce_not_reproducible", result: rep.exitCode !== 0 ? "pass" : "fail", detail: "reproduce exit=" + rep.exitCode + "(0=缺陷仍可复现)" });
  } else {
    checks.push({ name: "reproduce_not_reproducible", result: "skip", detail: "事项未配置 reproduce 命令" });
  }
  if (inc.testCommand) {
    const t = runCommand(inc.testCommand, { cwd: REPO, timeoutMs: 300000 });
    checks.push({ name: "test_passed", result: t.exitCode === 0 ? "pass" : "fail", detail: "test exit=" + t.exitCode + " " + t.outputTail.slice(0, 120) });
  } else {
    checks.push({ name: "test_passed", result: "skip", detail: "事项未配置 testCommand" });
  }
  return checks;
}

function printChecks(checks) {
  for (const c of checks) console.log("  [" + c.result + "] " + c.name + (c.detail ? " — " + c.detail : ""));
}

const TOOLS = {
  status({ json }) {
    const incs = sortIncidents(loadIncidents(REPO));
    const data = { incidents: incs.map((i) => ({ id: i.id, title: i.title, severity: i.severity, frequency: i.frequency, score: scoreOf(i), status: i.status ?? "open" })) };
    if (!json) {
      if (incs.length === 0) { console.log("无维护事项"); return out(true, data); }
      console.log("维护事项(严重度×频率排序):");
      for (const i of incs) console.log("  " + i.id + " [" + i.severity + " ×" + i.frequency + "=" + scoreOf(i) + "] " + i.title);
    }
    return out(true, data);
  },

  inspect({ id, json }) {
    const inc = findByPrefix(loadIncidents(REPO), id);
    if (!inc) return fail("未找到事项: " + id);
    const attempts = readAttempts().filter((a) => a.incidentId === inc.id);
    let knowledge = [];
    try {
      if (existsSync(KNOWLEDGE)) {
        knowledge = readdirSync(KNOWLEDGE).filter((f) => f.endsWith(".md") && (f.includes(inc.taxonomy ?? "") || f.includes(inc.id))).map((f) => f);
      }
    } catch {}
    const data = { incident: inc, attempts: attempts.length, knowledge, trace: inc.traceRef ? traceSummary(inc.traceRef) : undefined };
    if (!json) {
      console.log("# " + inc.id + " " + inc.title);
      console.log("severity=" + inc.severity + " frequency=" + inc.frequency + " status=" + (inc.status ?? "open"));
      if (inc.taxonomy) console.log("taxonomy=" + inc.taxonomy);
      console.log("reproduce: " + (inc.reproduce?.command ?? "(无)"));
      console.log("test: " + (inc.testCommand ?? "(无)"));
      if (inc.knowledge) console.log("knowledge: " + inc.knowledge);
      if (attempts.length) console.log("attempts=" + attempts.length + " 最近: " + JSON.stringify(attempts[attempts.length - 1]).slice(0, 200));
    }
    return out(true, data);
  },

  reproduce({ id, json }) {
    const inc = findByPrefix(loadIncidents(REPO), id);
    if (!inc) return fail("未找到事项: " + id);
    const cmd = inc.reproduce?.command;
    if (!cmd) return fail(inc.id + " 未配置 reproduce 命令");
    const r = runCommand(cmd, { cwd: inc.reproduce.workdir ? resolve(REPO, inc.reproduce.workdir) : REPO, timeoutMs: 120000 });
    const data = { incidentId: inc.id, reproduced: r.exitCode === 0, exitCode: r.exitCode, command: cmd, outputTail: r.outputTail };
    if (!json) console.log((data.reproduced ? "可复现 ✅" : "不可复现 ❌") + " (exit=" + r.exitCode + ")");
    return out(true, data);
  },

  test({ id, json }) {
    const inc = findByPrefix(loadIncidents(REPO), id);
    if (!inc) return fail("未找到事项: " + id);
    const cmd = inc.testCommand;
    if (!cmd) return fail(inc.id + " 未配置 testCommand");
    const r = runCommand(cmd, { cwd: REPO, timeoutMs: 300000 });
    const data = { incidentId: inc.id, passed: r.exitCode === 0, exitCode: r.exitCode, command: cmd, outputTail: r.outputTail };
    if (!json) console.log((data.passed ? "测试通过 ✅" : "测试失败 ❌") + " (exit=" + r.exitCode + ")");
    return out(true, data);
  },

  replay({ traceRef, json, before, after }) {
    if (before && after) {
      const d = diffTraces(before, after);
      if (!d.exists) return out(true, { exists: false, before: d.a, after: d.b }, ["before/after trace 至少一个不存在"]);
      if (!json) {
        console.log("=== 回放对比: " + before + " (修复前) vs " + after + " (修复后) ===");
        console.log("工具序列 A: " + (d.seqA.join(" → ") || "(空)"));
        console.log("工具序列 B: " + (d.seqB.join(" → ") || "(空)"));
        for (const c of d.changes) console.log("  [" + c.at + "] " + c.kind + ": " + c.detail);
        for (const c of d.resultChanges) console.log("  [" + c.at + "] 结果变化: " + c.tool + " exit " + c.exitCode);
        console.log("错误: " + d.errors.total + " (" + (d.reason.before ?? "?") + " → " + (d.reason.after ?? "?") + ")");
      }
      return out(true, d);
    }
    if (!traceRef) return fail("需要 --traceRef(或 --before + --after)");
    const d = deepReplay(traceRef);
    if (!d.exists) return out(true, { traceRef, exists: false }, ["trace 不存在"]);
    if (!json) {
      console.log("=== 回放: " + d.path + " (" + d.eventCount + " 事件) ===");
      console.log("会话: " + (d.session.title ?? "(无标题)") + " | 模型: " + (d.session.model ?? "?") + " | turns: " + (d.session.turns ?? "?") + " | tokens: " + (d.session.tokens ? d.session.tokens.in + "/" + d.session.tokens.out : "?") + " | 结果: " + (d.session.reason ?? "?"));
      for (const l of d.timeline) console.log(l);
    }
    return out(true, { traceRef, ...d });
  },

  verify({ scope = "contract", json, claim, incident }) {
    const contract = loadContract(REPO);
    const diffBase = process.env.DSH_MAINT_DIFF_BASE;
    let checks;
    let label;
    if (scope === "evidence") {
      if (!claim || !incident) return fail("evidence 需要 --claim <json> --incident <id>");
      checks = evidenceChecks(claim, incident, contract, diffBase);
      label = "证据核验(假完成拦截)";
    } else {
      checks = contractChecks(contract, diffBase);
      label = "契约验证";
      if (scope === "full") {
        const test = runCommand("pnpm test", { cwd: REPO, timeoutMs: 600000 });
        checks.push({ name: "tests", result: test.exitCode === 0 ? "pass" : "fail", detail: test.outputTail.slice(0, 400) });
        const build = runCommand("pnpm build", { cwd: REPO, timeoutMs: 600000 });
        checks.push({ name: "build", result: build.exitCode === 0 ? "pass" : "fail", detail: build.outputTail.slice(0, 400) });
      }
    }
    const okAll = checks.every((c) => c.result !== "fail");
    const data = { scope, checks, budget: contract.budget };
    if (!json) {
      printChecks(checks);
      console.log(okAll ? label + "通过 ✅" : label + "未通过 ❌");
    }
    return out(okAll, data);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--json") args.json = true;
  else if (rest[i] === "--traceRef") args.traceRef = rest[++i];
  else if (rest[i] === "--id") args.id = rest[++i];
  else if (rest[i] === "--scope") args.scope = rest[++i];
  else if (rest[i] === "--claim") args.claim = rest[++i];
  else if (rest[i] === "--incident") args.incident = rest[++i];
  else if (rest[i] === "--before") args.before = rest[++i];
  else if (rest[i] === "--after") args.after = rest[++i];
  // 位置参数:verify 的第一个位置参数是 scope;replay 的是 traceRef;其余命令是 id
  else if (cmd === "verify" && !args.scope) args.scope = rest[i];
  else if (cmd === "replay" && !args.traceRef) args.traceRef = rest[i];
  else if (!args.id) args.id = rest[i];
}
if (!TOOLS[cmd]) {
  console.error("用法: dsh-maint " + Object.keys(TOOLS).join("|"));
  process.exit(2);
}
try {
  TOOLS[cmd](args);
} catch (e) {
  fail(String(e));
  process.exit(1);
}