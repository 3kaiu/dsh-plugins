#!/usr/bin/env node
// dsh-maint —— 维护工具集(六工具 + 证据核验/回放/Benchmark/Checkpoint;协议见 docs/09 §4,布局见 06 §4)
// 用法:
//   dsh-maint status [--json]                   列出维护事项(严重度×频率排序)
//   dsh-maint inspect <incidentId> [--json]     查看单个事项完整现场
//   dsh-maint reproduce <incidentId> [--json]   重放最小复现(退出 0=缺陷可复现)
//   dsh-maint test <incidentId> [--json]        跑定向测试(修复前后对比)
//   dsh-maint replay <traceRef> [--json]        深度回放:会话元数据+工具调用序列+错误+timeline
//   dsh-maint replay --before <ref> --after <ref> [--json]  修复前后行为对比
//   dsh-maint benchmark <traceRef> [--json]      Agent Benchmark:行为指标(失败率/重试/错误密度/质量分)
//   dsh-maint benchmark --before <ref> --after <ref> [--json]  修复前后指标对比
//   dsh-maint checkpoint <incidentId> [--json]    创建恢复点(现场快照:事项/attempts/知识/git)
//   dsh-maint checkpoint list [--json]            列出恢复点
//   dsh-maint checkpoint restore <id> [--json]    读取恢复点并验证完整性
//   dsh-maint knowledge <incidentId> [--json]     查询事项知识(内嵌 + 知识文件)
//   dsh-maint knowledge add <incidentId> --text <...> [--json]  沉淀修复经验(追加去重)
//   dsh-maint knowledge list [--json]             列出全部知识
//   dsh-maint trace <incidentId> --from <eventsFile> [--json]  会话事件流落盘为事项 trace
//   dsh-maint guard --pr <PR号> [--json]             guarded auto-merge 判定(维护分支+verified+无needs-human+attempts<3+CI全绿)
//   dsh-maint guard --mock <PR数据json> [--json]     注入 PR 数据判定(测试/DoD 实测用)
//   dsh-maint benchmark <trace> --record [--incident <id>] [--json]  评分落盘(Agent Score 聚合输入)
//   dsh-maint score [--gate <阈值>] [--json]           Agent Score:聚合/趋势/下降归因 + 发行门禁(默认阈值 60)
//   dsh-maint verify contract [--json]          契约闸门(diff 范围/禁止路径/行数)
//   dsh-maint verify evidence --claim <json> --incident <id> [--json]
//                                            证据核验:agent 声明 vs 磁盘事实
// 统一返回:{ ok, data, diagnostics }
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
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
// Agent Benchmark:消费 trace 计算行为指标(效率/质量),支持修复前后对比
// 指标全部可解释:失败率/重试/错误密度直接来自事件流,不引入黑盒模型
function benchmarkMetrics(traceRef) {
  const d = deepReplay(traceRef);
  if (!d.exists) return { exists: false };
  const calls = d.calls;
  const toolCalls = calls.length;
  // 探测类工具(read/glob/grep/ls/cat/find/stat)exit 1 = "目标不存在"的探测结果,
  // 是 agent 正常探索路径的一部分,不计为执行失败;其余工具非 0 退出才是失败
  const PROBE_TOOLS = new Set(["read", "glob", "grep", "ls", "cat", "find", "stat"]);
  const failedCalls = calls.filter((c) => (c.exitCode ?? 0) !== 0 && !(PROBE_TOOLS.has(c.tool) && (c.exitCode ?? 0) === 1)).length;
  const failureRate = toolCalls ? failedCalls / toolCalls : 0;
  const toolKinds = new Set(calls.map((c) => c.tool)).size;
  const errorCount = d.errors.reduce((m, e) => m + (e.occurrences ?? 1), 0);
  const errorDensity = toolCalls ? errorCount / toolCalls : 0;
  const turns = d.session.turns ?? 0;
  const avgLatency = (() => {
    const lats = calls.map((c) => c.latencyMs).filter((x) => x != null);
    return lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
  })();
  // 质量分:基础 100 - 失败率 - 重试/错误惩罚(每项封顶,保证可解释)
  const quality = Math.max(0, Math.round((1 - failureRate - 0.15 * d.llmRetries - 0.1 * errorDensity) * 100));
  const verdict = quality >= 80 ? "good" : quality >= 60 ? "ok" : "poor";
  return {
    exists: true, path: d.path, eventCount: d.eventCount,
    metrics: {
      turns, toolCalls, toolKinds, avgLatencyMs: avgLatency,
      durationMs: d.session.durationMs ?? null,
      failedCalls, failureRate: +failureRate.toFixed(3),
      llmRetries: d.llmRetries, errors: d.errors, errorDensity: +errorDensity.toFixed(3),
      reason: d.session.reason ?? null,
    },
    quality, verdict,
  };
}
// 修复前后 Benchmark 对比:每项指标给变化方向
function compareBenchmarks(beforeRef, afterRef) {
  const a = benchmarkMetrics(beforeRef);
  const b = benchmarkMetrics(afterRef);
  if (!a.exists || !b.exists) return { exists: false, a: a.exists, b: b.exists };
  const deltas = {};
  for (const k of ["toolCalls", "failedCalls", "llmRetries", "errorDensity", "failureRate", "quality"]) {
    const va = a.metrics[k] ?? a[k], vb = b.metrics[k] ?? b[k];
    if (typeof va === "number" && typeof vb === "number") {
      deltas[k] = { before: va, after: vb, delta: +(vb - va).toFixed(3) };
    }
  }
  const improved = deltas.failureRate && deltas.failureRate.delta < 0 ? ["failureRate"] : [];
  if (deltas.llmRetries && deltas.llmRetries.delta < 0) improved.push("llmRetries");
  if (deltas.errorDensity && deltas.errorDensity.delta < 0) improved.push("errorDensity");
  if (deltas.quality && deltas.quality.delta > 0) improved.push("quality");
  return {
    exists: true, before: a, after: b, deltas,
    verdict: { before: a.verdict, after: b.verdict, improved },
  };
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

  guard({ pr, mock, json }) {
    // guarded auto-merge 判定:维护分支 + verified 标签 + 无 needs-human + attempts<3 + CI 全绿
    // --pr <PR号> 走真实 gh 数据;--mock <json> 注入 PR 数据(单测/DoD 实测用)
    if (!pr && !mock) return fail("需要 --pr <PR号> 或 --mock <PR数据JSON>");
    let info;
    if (mock) {
      if (!existsSync(mock)) return fail("mock 文件不存在: " + mock);
      info = JSON.parse(readFileSync(mock, "utf8"));
    } else {
      info = JSON.parse(execSync("gh pr view " + pr + " --json number,title,headRefName,labels,body,mergeable,mergeStateStatus", { encoding: "utf8" }));
    }
    const reasons = [];
    const ok = (cond, msg) => { if (!cond) reasons.push(msg); };
    const head = String(info.headRefName ?? "");
    ok(head.startsWith("maintenance/"), "非维护分支: " + (head || "?"));
    const labels = (info.labels ?? []).map((l) => String(l.name ?? l).toLowerCase());
    ok(!labels.includes("needs-human"), "存在 needs-human 标签(需人工介入)");
    ok(labels.includes("verified"), "缺少 verified 标签(evidence 闸门未通过)");
    const m = String(info.body ?? "").match(/attempts:\s*(\d+)/i);
    const attempts = m ? parseInt(m[1], 10) : 0;
    ok(attempts < 3, "attempts=" + attempts + " 达到 budget 上限(≥3)");
    const mss = String(info.mergeStateStatus ?? "");
    ok(mss === "CLEAN" || mss === "READY", "CI 未全绿或不可合并(mergeStateStatus=" + (mss || "?") + ")");
    const allowMerge = reasons.length === 0;
    if (!json) {
      if (allowMerge) console.log("✅ 放行合并: PR #" + (info.number ?? pr) + " (" + head + ", attempts=" + attempts + ", CI " + mss + ")");
      else console.log("❌ 拦截合并: " + reasons.join("; "));
    }
    return out(true, { pr: Number(pr || info.number || 0), allowMerge, head, attempts, labels, mergeStateStatus: mss, reasons });
  },

  trace({ id, from, json }) {
    // trace import <incidentId> <eventsFile>:把会话事件流落盘为事项的 trace 文件
    if (!id) return fail("需要事项 ID");
    if (!from) return fail("需要 --from <事件文件路径>");
    const inc = loadIncidents().find((i) => i.id === id || i.id.startsWith(id));
    if (!inc) return fail("事项不存在: " + id);
    if (!existsSync(from)) return fail("事件文件不存在: " + from);
    const lines = readFileSync(from, "utf8").split("\n").filter(Boolean).filter((l) => { try { JSON.parse(l); return true; } catch { return false; } });
    if (!lines.length) return fail("事件文件没有合法 JSON 行");
    const dest = inc.traceRef ? join(REPO, inc.traceRef) : join(STATE, "traces", inc.id + ".jsonl");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, lines.join("\n") + "\n");
    const summary = traceSummary(dest);
    if (!json) console.log("trace 已落盘: " + dest + " (" + summary.eventCount + " 事件)");
    return out(true, { incidentId: inc.id, dest, eventCount: summary.eventCount });
  },

  knowledge({ action = "query", id, text, json }) {
    if (action === "list") {
      const files = existsSync(KNOWLEDGE) ? readdirSync(KNOWLEDGE).filter((f) => f.endsWith(".md")).sort() : [];
      const embedded = loadIncidents().filter((i) => i.knowledge).map((i) => ({ id: i.id, note: i.knowledge }));
      if (!json) { for (const f of files) console.log(f); for (const e of embedded) console.log(e.id + ": " + e.note); }
      return out(true, { files, embedded });
    }
    if (action === "add") {
      if (!id) return fail("需要事项 ID");
      if (!text) return fail("需要 --text");
      const inc = loadIncidents().find((i) => i.id === id || i.id.startsWith(id));
      if (!inc) return fail("事项不存在: " + id);
      mkdirSync(KNOWLEDGE, { recursive: true });
      const p = join(KNOWLEDGE, inc.id + ".md");
      const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
      if (existing.includes(text)) {
        if (!json) console.log("知识已存在,跳过: " + inc.id + ".md");
        return out(true, { added: false, file: inc.id + ".md" });
      }
      const entry = "## " + new Date().toISOString() + "\n" + text + "\n";
      writeFileSync(p, existing + entry);
      if (!json) console.log("知识已沉淀: .dsh/knowledge/" + inc.id + ".md");
      return out(true, { added: true, file: inc.id + ".md" });
    }
    // query(默认):内嵌 knowledge + 知识文件
    if (!id) return fail("需要事项 ID");
    const inc = loadIncidents().find((i) => i.id === id || i.id.startsWith(id));
    if (!inc) return fail("事项不存在: " + id);
    const files = existsSync(KNOWLEDGE) ? readdirSync(KNOWLEDGE).filter((f) => f.endsWith(".md") && (f.includes(inc.taxonomy ?? "") || f.includes(inc.id))) : [];
    const notes = files.map((f) => ({ file: f, content: readFileSync(join(KNOWLEDGE, f), "utf8") }));
    if (!json) {
      if (inc.knowledge) console.log("内嵌: " + inc.knowledge);
      for (const n of notes) { console.log("--- " + n.file + " ---"); console.log(n.content); }
    }
    return out(true, { incidentId: inc.id, embedded: inc.knowledge ?? null, files, notes });
  },

  checkpoint({ action = "create", id, json }) {
    const dir = join(STATE, "checkpoints");
    if (action === "list") {
      if (!existsSync(dir)) return out(true, { checkpoints: [] });
      const items = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
        try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; }
      }).filter(Boolean).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      if (!json) for (const i of items) console.log(i.id + "  " + (i.createdAt ?? "") + "  " + (i.incident?.title ?? "?") + "  attempts=" + i.attempts + "  head=" + String(i.git?.head ?? "?").slice(0, 7));
      return out(true, { checkpoints: items });
    }
    if (action === "restore") {
      if (!id) return fail("需要快照 id(create 时返回的 id,或文件路径)");
      const candidates = [join(dir, id), join(dir, id + ".json"), join(REPO, id), id];
      for (const p of candidates) {
        if (!existsSync(p)) continue;
        let snap;
        try { snap = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
        const required = ["id", "incidentId", "createdAt", "incident", "attempts", "knowledge", "git"];
        const missing = required.filter((k) => !(k in snap));
        if (!json) {
          console.log("=== 恢复点 " + snap.id + " (" + (snap.createdAt ?? "?") + ") ===");
          console.log("事项: " + (snap.incident?.title ?? "?") + " [" + snap.incidentId + "]  status=" + (snap.incident?.status ?? "?"));
          console.log("attempts: " + snap.attempts + " | knowledge: " + (snap.knowledge ?? []).join(", "));
          console.log("git: " + (snap.git?.head ?? "?") + (snap.git?.dirty ? " (dirty)" : "") + " | trace: " + (snap.trace?.exists ? snap.trace.eventCount + " 事件" : "无"));
          console.log("完整性: " + (missing.length === 0 ? "完整 ✅" : "缺失字段 " + missing.join(",")));
        }
        return out(true, { restored: missing.length === 0, snapshot: snap, missing });
      }
      return out(true, { restored: false }, ["快照不存在"]);
    }
    // create(默认):对事项做状态快照,供中断后恢复执行
    if (!id) return fail("需要事项 ID");
    const inc = loadIncidents().find((i) => i.id === id || i.id.startsWith(id));
    if (!inc) return fail("事项不存在: " + id);
    const attempts = readAttempts().filter((a) => a.incidentId === id);
    const knowledge = existsSync(KNOWLEDGE) ? readdirSync(KNOWLEDGE) : [];
    const head = runCommand("git rev-parse HEAD", { cwd: REPO, timeoutMs: 30000 }).stdout.trim();
    const dirty = runCommand("git status --porcelain", { cwd: REPO, timeoutMs: 30000 }).stdout.trim() !== "";
    const ts = new Date().toISOString();
    const snapId = id + "-" + ts.replace(/[^0-9T]/g, "").slice(0, 15);
    const snap = {
      id: snapId, incidentId: inc.id, createdAt: ts,
      incident: inc, attempts: attempts.length, knowledge,
      trace: inc.traceRef ? traceSummary(inc.traceRef) : null,
      git: { head, dirty },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, snapId + ".json"), JSON.stringify(snap, null, 2));
    if (!json) console.log("检查点已创建: " + snapId + " (attempts=" + attempts.length + ", head=" + head.slice(0, 7) + (dirty ? ", dirty" : "") + ")");
    return out(true, { checkpoint: snap });
  },

  benchmark({ traceRef, json, before, after, record, incident }) {
    if (before && after) {
      const c = compareBenchmarks(before, after);
      if (!c.exists) return out(true, { exists: false, before: c.a, after: c.b }, ["before/after trace 至少一个不存在"]);
      if (!json) {
        console.log("=== Benchmark 对比: " + before + " (修复前) vs " + after + " (修复后) ===");
        const pad = (k, v) => console.log("  " + String(k).padEnd(14) + " " + v);
        for (const k of ["toolCalls", "failedCalls", "llmRetries", "errorDensity", "failureRate", "quality"]) {
          const dlt = c.deltas[k];
          if (!dlt) continue;
          const arrow = dlt.delta < 0 ? "↓" : dlt.delta > 0 ? "↑" : "→";
          pad(k, dlt.before.toFixed(3) + " → " + dlt.after.toFixed(3) + " " + arrow);
        }
        pad("verdict", c.verdict.before + " → " + c.verdict.after + (c.verdict.improved.length ? " (改善: " + c.verdict.improved.join(", ") + ")" : ""));
      }
      return out(true, c);
    }
    if (!traceRef) return fail("需要 --traceRef(或 --before + --after)");
    const m = benchmarkMetrics(traceRef);
    if (!m.exists) return out(true, { traceRef, exists: false }, ["trace 不存在"]);
    if (!json) {
      console.log("=== Benchmark: " + m.path + " (" + m.eventCount + " 事件) ===");
      const pad = (k, v) => console.log("  " + String(k).padEnd(14) + " " + v);
      pad("turns", m.metrics.turns);
      pad("toolCalls", m.metrics.toolCalls + " (种类 " + m.metrics.toolKinds + ")");
      pad("failedCalls", m.metrics.failedCalls + " (失败率 " + (m.metrics.failureRate * 100).toFixed(0) + "%)");
      pad("llmRetries", m.metrics.llmRetries);
      pad("errors", m.metrics.errors.reduce((s, e) => s + e.taxonomy + " ×" + (e.occurrences ?? 1) + " ", ""));
      pad("avgLatency", m.metrics.avgLatencyMs != null ? m.metrics.avgLatencyMs + "ms" : "-");
      pad("reason", m.metrics.reason ?? "-");
      pad("quality", m.quality + "/100 (" + m.verdict + ")");
    }
    if (record) {
      // --record:评分落盘,供 Agent Score/Analytics 聚合(Phase 4)
      const bDir = join(STATE, "benchmarks");
      mkdirSync(bDir, { recursive: true });
      const incId = incident || (traceRef ? basename(traceRef).replace(/\.jsonl?$/, "") : "unknown");
      const rec = { at: new Date().toISOString(), trace: traceRef, quality: m.quality, verdict: m.verdict, metrics: m.metrics };
      const file = join(bDir, incId + ".json");
      const list = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      list.push(rec);
      writeFileSync(file, JSON.stringify(list, null, 2));
      if (!json) console.log("评分已记录: .dsh/state/benchmarks/" + incId + ".json (" + list.length + " 条)");
      return out(true, { traceRef, ...m, recorded: { incidentId: incId, runs: list.length } });
    }
    return out(true, { traceRef, ...m });
  },

  score({ json, gate, id }) {
    // Agent Score/Analytics:聚合全部 benchmark 记录,含趋势与下降归因;--gate <阈值> 做发行门禁
    const bDir = join(STATE, "benchmarks");
    const files = existsSync(bDir) ? readdirSync(bDir).filter((f) => f.endsWith(".json")) : [];
    const all = [];
    for (const f of files) {
      const recs = (() => { try { return JSON.parse(readFileSync(join(bDir, f), "utf8")); } catch { return []; } })();
      for (const r of recs) all.push({ incidentId: f.replace(/\.json$/, ""), ...r });
    }
    all.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
    const runs = all.length;
    const avgQuality = runs ? Math.round(all.reduce((s, r) => s + r.quality, 0) / runs) : 0;
    const last = all[runs - 1];
    const byIncident = [...new Set(all.map((r) => r.incidentId))].map((incId) => {
      const recs = all.filter((r) => r.incidentId === incId);
      const regressions = [];
      for (let i = 1; i < recs.length; i++) {
        const prev = recs[i - 1], cur = recs[i];
        const drop = prev.quality - cur.quality;
        if (drop >= 20) {
          // 归因:三个指标中变化贡献最大的为主因
          const dF = (cur.metrics?.failureRate ?? 0) - (prev.metrics?.failureRate ?? 0);
          const dR = (cur.metrics?.llmRetries ?? 0) - (prev.metrics?.llmRetries ?? 0);
          const dE = (cur.metrics?.errorDensity ?? 0) - (prev.metrics?.errorDensity ?? 0);
          const maxAbs = Math.max(Math.abs(dF), Math.abs(dR), Math.abs(dE));
          const cause = maxAbs === 0 ? "综合" : Math.abs(dF) === maxAbs ? "failureRate" : Math.abs(dR) === maxAbs ? "llmRetries" : "errorDensity";
          regressions.push({ at: cur.at, from: prev.quality, to: cur.quality, drop, cause, detail: "失败率 " + dF.toFixed(2) + " / 重试 " + dR.toFixed(1) + " / 错误密度 " + dE.toFixed(2) });
        }
      }
      return { id: incId, runs: recs.length, avgQuality: Math.round(recs.reduce((s, r) => s + r.quality, 0) / recs.length), lastQuality: recs[recs.length - 1].quality, trend: recs.map((r) => r.quality), regressions };
    });
    const byTaxonomy = [...new Set(loadIncidents().filter((i) => all.some((r) => r.incidentId.startsWith(i.id))).map((i) => i.taxonomy ?? "UNKNOWN"))].map((t) => {
      const ids = loadIncidents().filter((i) => (i.taxonomy ?? "UNKNOWN") === t).map((i) => i.id);
      const recs = all.filter((r) => ids.some((x) => r.incidentId.startsWith(x)));
      return { taxonomy: t, runs: recs.length, avgQuality: recs.length ? Math.round(recs.reduce((s, r) => s + r.quality, 0) / recs.length) : 0 };
    });
    const threshold = gate != null ? Number(gate) : 60;
    // 发行门禁看"最新一次评分"(历史失败已修复不惩罚当前);avg 仅作趋势展示
    const pass = runs > 0 && (last?.quality ?? 0) >= threshold && (last?.metrics?.reason ?? "completed") === "completed";
    if (!json) {
      console.log("=== Agent Score(" + runs + " 次评分,平均 " + avgQuality + "/100) ===");
      for (const b of byIncident) {
        console.log("  " + b.id + ": " + b.runs + " 次,avg " + b.avgQuality + ",trend [" + b.trend.join(" → ") + "]");
        for (const rg of b.regressions) console.log("    ⚠ 下降 " + rg.from + "→" + rg.to + "(" + rg.drop + ") 主因 " + rg.cause + " [" + rg.detail + "]");
      }
      for (const t of byTaxonomy) console.log("  分类 " + t.taxonomy + ": " + t.runs + " 次,avg " + t.avgQuality);
      console.log("gate: " + threshold + " → " + (pass ? "通过 ✅" : "不通过 ❌"));
    }
    return out(true, { runs, avgQuality, last: last ? { at: last.at, quality: last.quality, reason: last.metrics?.reason ?? null, incidentId: last.incidentId } : null, byIncident, byTaxonomy, gate: { threshold, pass } });
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
  else if ((cmd === "replay" || cmd === "benchmark") && !args.traceRef) args.traceRef = rest[i];
  else if (cmd === "trace" && rest[i] !== "--from" && !args.id) args.id = rest[i];
  else if (rest[i] === "--from") args.from = rest[++i];
  else if (cmd === "checkpoint" && (rest[i] === "list" || rest[i] === "restore" || rest[i] === "create")) args.action = rest[i];
  else if (cmd === "knowledge" && (rest[i] === "list" || rest[i] === "add")) args.action = rest[i];
  else if (rest[i] === "--text") args.text = rest[++i];
  else if (rest[i] === "--pr") args.pr = rest[++i];
  else if (rest[i] === "--mock") args.mock = rest[++i];
  else if (rest[i] === "--record") args.record = true;
  else if (rest[i] === "--gate") args.gate = rest[++i];
  else if (rest[i] === "--incident") args.incident = rest[++i];
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