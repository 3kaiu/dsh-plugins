#!/usr/bin/env node
// dsh-maint —— 维护六工具(协议见 docs/09 §4,布局见 06 §4)+ 证据核验(Phase 2)
// 用法:
//   dsh-maint status [--json]                   列出维护事项(严重度×频率排序)
//   dsh-maint inspect <incidentId> [--json]     查看单个事项完整现场
//   dsh-maint reproduce <incidentId> [--json]   重放最小复现(退出 0=缺陷可复现)
//   dsh-maint test <incidentId> [--json]        跑定向测试(修复前后对比)
//   dsh-maint replay <traceRef> [--json]        (Phase 2 深度回放;现为 trace 摘要)
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
function traceSummary(traceRef) {
  // traceRef 支持:仓库内 .dsh/state/traces/<ref>.jsonl,或 events 家族文件路径
  const candidates = [join(STATE, "traces", traceRef), join(REPO, traceRef), traceRef];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const first = lines[0] ? JSON.parse(lines[0]) : null;
    const last = lines[lines.length - 1] ? JSON.parse(lines[lines.length - 1]) : null;
    return { exists: true, path: p, eventCount: lines.length, firstType: first?.type ?? null, lastType: last?.type ?? null };
  }
  return { exists: false, eventCount: 0 };
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

  replay({ traceRef, json }) {
    if (!traceRef) return fail("需要 --traceRef");
    const t = traceSummary(traceRef);
    if (!t.exists) return out(true, { traceRef, exists: false }, ["trace 不存在,深度回放为 Phase 2 能力"]);
    const data = { traceRef, exists: true, eventCount: t.eventCount, firstType: t.firstType, lastType: t.lastType };
    if (!json) console.log("trace " + traceRef + ": " + t.eventCount + " 事件, " + t.firstType + " → " + t.lastType);
    return out(true, data);
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
  // 位置参数:verify 的第一个位置参数是 scope,其余命令是 id
  else if (cmd === "verify" && !args.scope) args.scope = rest[i];
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