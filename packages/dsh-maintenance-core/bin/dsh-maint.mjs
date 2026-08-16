#!/usr/bin/env node
// dsh-maint —— 维护六工具(协议见 docs/09 §4,布局见 docs/06 §4)
// 用法:
//   dsh-maint status [--json]                   列出维护事项(严重度×频率排序)
//   dsh-maint inspect <incidentId> [--json]     查看单个事项完整现场
//   dsh-maint reproduce <incidentId> [--json]   重放最小复现(退出 0=缺陷可复现)
//   dsh-maint test <incidentId> [--json]        跑定向测试(修复前后对比)
//   dsh-maint replay <traceRef> [--json]        (Phase 2 深度回放;现为 trace 摘要)
//   dsh-maint verify [contract|full] [--json]   契约/全量验证闸门
// 统一返回:{ ok, data, diagnostics }
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadIncidents, sortIncidents, findByPrefix, scoreOf, SEVERITY_WEIGHT } from "../lib/incidents.mjs";
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

const TOOLS = {
  status({ json }) {
    const incs = sortIncidents(loadIncidents(REPO));
    if (!json) {
      if (incs.length === 0) { console.log("无维护事项"); return out(true, { incidents: [] }); }
      console.log("维护事项(严重度×频率排序):");
      for (const i of incs) console.log("  " + i.id + " [" + i.severity + " ×" + i.frequency + "=" + scoreOf(i) + "] " + i.title);
      return out(true, { incidents: incs.map((i) => ({ id: i.id, title: i.title, severity: i.severity, frequency: i.frequency, score: scoreOf(i), status: i.status ?? "open" })) });
    }
    return out(true, { incidents: incs.map((i) => ({ id: i.id, title: i.title, severity: i.severity, frequency: i.frequency, score: scoreOf(i), status: i.status ?? "open" })) });
  },

  inspect({ id, json }) {
    const inc = findByPrefix(loadIncidents(REPO), id);
    if (!inc) return fail("未找到事项: " + id);
    const attempts = readAttempts().filter((a) => a.incidentId === inc.id);
    // 关联知识:knowledge 目录中文件名包含 taxonomy 或 id 的 md
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
    // 约定:reproduce 退出 0 = 缺陷稳定可复现
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

  verify({ scope = "contract", json }) {
    const contract = loadContract(REPO);
    const checks = [];
    // 1) 契约:diff 范围 + 禁止路径
    const diffBase = process.env.DSH_MAINT_DIFF_BASE;
    let files = [];
    if (diffBase) {
      const r = runCommand("git diff --name-only " + diffBase, { cwd: REPO, timeoutMs: 30000 });
      files = r.stdout.split("\n").filter(Boolean);
      const diff = checkDiff(files, contract, REPO);
      checks.push(...diff.checks);
    } else {
      checks.push({ name: "no_forbidden_paths", result: "skip", detail: "未提供 diff 基准(DSH_MAINT_DIFF_BASE)" });
      checks.push({ name: "max_changed_files", result: "skip", detail: "未提供 diff 基准" });
    }
    // 2) max diff lines
    if (diffBase) {
      const r = runCommand("git diff --numstat " + diffBase, { cwd: REPO, timeoutMs: 30000 });
      let total = 0;
      for (const l of r.stdout.split("\n")) {
        const m = l.match(/^(\d+)\s+(\d+)\s/);
        if (m) total += Number(m[1]) + Number(m[2]);
      }
      checks.push({ name: "max_diff_lines", result: total <= contract.budget.maxDiffLines ? "pass" : "fail", detail: total + "/" + contract.budget.maxDiffLines });
    } else {
      checks.push({ name: "max_diff_lines", result: "skip", detail: "未提供 diff 基准" });
    }
    if (scope === "full") {
      const test = runCommand("pnpm test", { cwd: REPO, timeoutMs: 600000 });
      checks.push({ name: "tests", result: test.exitCode === 0 ? "pass" : "fail", detail: test.outputTail.slice(0, 400) });
      const build = runCommand("pnpm build", { cwd: REPO, timeoutMs: 600000 });
      checks.push({ name: "build", result: build.exitCode === 0 ? "pass" : "fail", detail: build.outputTail.slice(0, 400) });
    }
    // skip = 条件不适用(如未提供 diff 基准),不视为失败
    const okAll = checks.every((c) => c.result !== "fail");
    const data = { scope, checks, budget: contract.budget };
    if (!json) {
      for (const c of checks) console.log("  [" + c.result + "] " + c.name + (c.detail ? " — " + c.detail : ""));
      console.log(okAll ? "契约验证通过 ✅" : "契约验证未通过 ❌");
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
