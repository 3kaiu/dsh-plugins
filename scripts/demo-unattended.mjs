#!/usr/bin/env node
// demo-unattended.mjs —— 无人值守维护演示:时间线"00:00 失败 → 02:40 修复合入"(压缩模拟,全走真实 CLI)
// 用法: node scripts/demo-unattended.mjs   (exit 0 = 演示通过)
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const BIN = resolve("packages/dsh-maintenance-core/bin/dsh-maint.mjs");
const repo = mkdtempSync(join(tmpdir(), "unattended-"));
const run = (args, env = {}) => JSON.parse(execSync("node " + BIN + " " + args, { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo, ...env } }));
const ev = (type, at, data) => JSON.stringify({ seq: 1, type, at, sessionId: "u1", data });
const trace = (file, evs) => { writeFileSync(join(repo, file), evs.join("\n") + "\n"); };
// 初始事项
mkdirSync(join(repo, ".dsh", "incidents"), { recursive: true });
writeFileSync(join(repo, ".dsh", "incidents", "inc-u.json"), JSON.stringify({
  id: "INC-U-001", title: "demo:目标文件缺失", severity: "MEDIUM", frequency: 2, taxonomy: "DOC_MISSING", status: "open",
  traceRef: ".dsh/state/traces/inc-u.jsonl",
  reproduce: { command: "node -e \"process.exit(require('fs').existsSync('u.txt') ? 1 : 0)\"", workdir: "." },
  testCommand: "node -e \"require('fs').readFileSync('u.txt','utf8');console.log('ok')\""
}, null, 2));
execSync("git init -q && git config user.email demo@local && git config user.name demo && git add -A && git commit -qm base", { cwd: repo });

const t = (s) => "[" + s + "]";
console.log("===== 无人值守维护演示(压缩时间线) =====");

// 00:00 失败——第一次尝试(探测失败 + 修复失败,reason=failed)
trace("before.jsonl", [
  ev("session.started", "2026-08-17T00:00:00.000Z", { title: "修复 u.txt" }),
  ev("turn/start", "2026-08-17T00:00:01.000Z", {}),
  ev("tool.started", "2026-08-17T00:00:02.000Z", { tool: "bash", inputSummary: "cat u.txt" }),
  ev("tool.completed", "2026-08-17T00:00:03.000Z", { tool: "bash", exitCode: 1, latencyMs: 30, stdoutTail: "ENOENT" }),
  ev("error.recorded", "2026-08-17T00:00:04.000Z", { taxonomy: "REPRODUCE_FAILED", severity: "LOW", occurrences: 2 }),
  ev("llm/retry", "2026-08-17T00:00:05.000Z", { error: "timeout" }),
  ev("session.completed", "2026-08-17T00:00:10.000Z", { reason: "failed", turns: 2 })
]);
const b1 = run("benchmark before.jsonl --record --incident INC-U-001 --json");
console.log(t("00:00") + " 失败:quality " + b1.data.quality + " (" + b1.data.verdict + ", reason=" + b1.data.metrics.reason + ")");

// 01:00 恢复点:中断后恢复现场
const ck = run("checkpoint INC-U-001 --json");
console.log(t("01:00") + " 恢复点:" + ck.data.checkpoint.id + "(attempts=" + ck.data.checkpoint.attempts + ", head=" + String(ck.data.checkpoint.git.head).slice(0, 7) + ")");

// 02:00 修复——第二次尝试成功
writeFileSync(join(repo, "u.txt"), "FIXED");
execSync("git add u.txt", { cwd: repo });
writeFileSync(join(repo, "claim.json"), JSON.stringify({ incidentId: "INC-U-001", changedFiles: ["u.txt"], summary: "u.txt 已创建" }));
trace("after.jsonl", [
  ev("session.started", "2026-08-17T02:00:00.000Z", { title: "修复 u.txt" }),
  ev("turn/start", "2026-08-17T02:00:01.000Z", {}),
  ev("tool.started", "2026-08-17T02:00:02.000Z", { tool: "bash", inputSummary: "echo FIXED > u.txt" }),
  ev("tool.completed", "2026-08-17T02:00:03.000Z", { tool: "bash", exitCode: 0, latencyMs: 15, stdoutTail: "" }),
  ev("tool.started", "2026-08-17T02:00:04.000Z", { tool: "bash", inputSummary: "node test" }),
  ev("tool.completed", "2026-08-17T02:00:05.000Z", { tool: "bash", exitCode: 0, latencyMs: 8, stdoutTail: "ok" }),
  ev("session.completed", "2026-08-17T02:00:06.000Z", { reason: "completed", turns: 1 })
]);
const b2 = run("benchmark after.jsonl --record --incident INC-U-001 --json");
console.log(t("02:00") + " 修复:quality " + b2.data.quality + " (" + b2.data.verdict + ", reason=" + b2.data.metrics.reason + ")");

// 02:20 证据闸门
const evd = run("verify evidence --claim " + join(repo, "claim.json") + " --incident INC-U-001 --json", { DSH_MAINT_DIFF_BASE: "HEAD" });
console.log(t("02:20") + " evidence 闸门:" + (evd.ok ? "放行 ✅" : "拦截 ❌"));

// 02:30 guarded merge 判定(mock PR 数据:维护分支 + verified + attempts 1 + CI 绿)
writeFileSync(join(repo, "pr.json"), JSON.stringify({ number: 66, headRefName: "maintenance/INC-U-001-20260817023000", labels: [{ name: "verified" }], body: "Agent 自动修复(INC-U-001)\n\nattempts: 1", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }));
const gd = run("guard --mock " + join(repo, "pr.json") + " --json");
console.log(t("02:30") + " guard 判定:" + (gd.data.allowMerge ? "放行 ✅" : "拦截 ❌ " + gd.data.reasons.join(";")));

// 02:40 合入 + 知识沉淀
const kn = run("knowledge add INC-U-001 --text \"u.txt 类缺失:先探测再创建,一次完成\" --json");
console.log(t("02:40") + " 合入(模拟 squash merge)+ 知识:" + kn.data.file);

// 发行门禁 + 归因
const sc = run("score --gate 60 --json");
console.log("----- Agent Score -----");
console.log("  运行 " + sc.data.runs + " 次,avg " + sc.data.avgQuality + "/100,趋势 [" + sc.data.byIncident[0].trend.join(" → ") + "]");
for (const rg of sc.data.byIncident[0].regressions) console.log("  ⚠ 下降 " + rg.from + "→" + rg.to + " 主因 " + rg.cause);
console.log("  发行门禁(阈值 " + sc.data.gate.threshold + "):" + (sc.data.gate.pass ? "通过 ✅" : "不通过 ❌"));
const okAll = b2.data.quality >= 80 && evd.ok === true && gd.data.allowMerge === true && sc.data.gate.pass === true;
console.log("===== 无人值守演示 " + (okAll ? "通过 ✅" : "失败 ❌") + " =====");
process.exit(okAll ? 0 : 1);
