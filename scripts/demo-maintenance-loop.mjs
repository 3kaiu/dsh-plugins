#!/usr/bin/env node
// demo-maintenance-loop.mjs —— 一键演示真实维护闭环链路(本地模拟 agent 修复,全部走真实 CLI 代码路径)
// 链路:incident → 模拟修复 → trace 落盘 → evidence 闸门 → checkpoint → knowledge → replay → benchmark
// 用法: node scripts/demo-maintenance-loop.mjs   (exit 0 = 链路通过)
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const BIN = resolve("packages/dsh-maintenance-core/bin/dsh-maint.mjs");
const repo = mkdtempSync(join(tmpdir(), "maint-loop-"));
// 1. incident + contract
mkdirSync(join(repo, ".dsh", "incidents"), { recursive: true });
writeFileSync(join(repo, ".dsh", "incidents", "inc-loop.json"), JSON.stringify({
  id: "INC-LOOP-001", title: "demo:target.txt 应含 FIXED", severity: "LOW", frequency: 1, taxonomy: "DEMO", status: "open",
  traceRef: ".dsh/state/traces/inc-loop.jsonl",
  reproduce: { command: "node -e \"process.exit(require('fs').existsSync('target.txt') && require('fs').readFileSync('target.txt','utf8').includes('FIXED') ? 1 : 0)\"", workdir: "." },
  testCommand: "node -e \"const t=require('fs').readFileSync('target.txt','utf8');if(!t.includes('FIXED'))process.exit(1);console.log('ok')\""
}, null, 2));
writeFileSync(join(repo, ".dsh", "autopilot.yml"), "budget:\n  max_runs_per_day: 3\n  max_attempts_per_issue: 3\n  max_changed_files: 15\n  max_diff_lines: 500\n  max_runtime: 15m\npermissions:\n  allow: [\"**\"]\n  deny: []\n");
execSync("git init -q && git config user.email demo@local && git config user.name demo && git add -A && git commit -qm base", { cwd: repo });
const run = (args, env = {}) => JSON.parse(execSync("node " + BIN + " " + args, { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo, ...env } }));

// 2. 模拟 agent 修复:改文件 + 声明
writeFileSync(join(repo, "target.txt"), "FIXED done");
execSync("git add target.txt", { cwd: repo });
writeFileSync(join(repo, "claim.json"), JSON.stringify({ incidentId: "INC-LOOP-001", changedFiles: ["target.txt"], summary: "target.txt 已含 FIXED" }));
// 3. 模拟会话事件流(trace)
const evs = [
  { type: "session.started", at: "2026-08-17T06:00:00.000Z", data: { title: "修复 target.txt" } },
  { type: "request/context", at: "2026-08-17T06:00:01.000Z", data: { provider: "opencode-zen", model: "deepseek-v4-flash-free", contextWindow: 131072 } },
  { type: "turn/start", at: "2026-08-17T06:00:02.000Z", data: {} },
  { type: "tool.started", at: "2026-08-17T06:00:03.000Z", data: { tool: "read", inputSummary: "target.txt" } },
  { type: "tool.completed", at: "2026-08-17T06:00:04.000Z", data: { tool: "read", exitCode: 1, latencyMs: 12, stdoutTail: "ENOENT" } },
  { type: "tool.started", at: "2026-08-17T06:00:05.000Z", data: { tool: "bash", inputSummary: "echo FIXED done > target.txt" } },
  { type: "tool.completed", at: "2026-08-17T06:00:06.000Z", data: { tool: "bash", exitCode: 0, latencyMs: 45, stdoutTail: "" } },
  { type: "session.completed", at: "2026-08-17T06:00:10.000Z", data: { reason: "completed", turns: 2, tokens: { in: 1500, out: 210 }, durationMs: 10000 } }
];
writeFileSync(join(repo, "events.jsonl"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");

console.log("===== 维护闭环链路演示(tmp 仓库 " + repo + ") =====");
// 4. trace 落盘
const tr = run("trace INC-LOOP-001 --from events.jsonl --json");
// 5. evidence 闸门
const ev = run("verify evidence --claim " + join(repo, "claim.json") + " --incident INC-LOOP-001 --json", { DSH_MAINT_DIFF_BASE: "HEAD" });
// 6. checkpoint
const ck = run("checkpoint INC-LOOP-001 --json");
// 7. knowledge
const kn = run("knowledge add INC-LOOP-001 --text \"demo 经验:target.txt 类缺失先用 read 探测\" --json");
// 8. replay
const rp = run("replay .dsh/state/traces/inc-loop.jsonl --json");
// 9. benchmark
const bm = run("benchmark .dsh/state/traces/inc-loop.jsonl --json");

const okAll = tr.data.eventCount === 8 && ev.ok === true && ck.data.checkpoint.incidentId === "INC-LOOP-001" && kn.data.added === true && rp.data.calls.length === 2 && bm.data.quality >= 80;
const passN = ev.data.checks.filter((c) => c.result === "pass").length;
console.log("  trace 落盘       " + tr.data.eventCount + " 事件 → " + tr.data.dest);
console.log("  evidence 闸门    " + (ev.ok ? "放行 ✅" : "拦截 ❌") + " (" + passN + "/" + ev.data.checks.length + " 项 pass)");
console.log("  checkpoint      " + ck.data.checkpoint.id);
console.log("  knowledge       已沉淀: " + kn.data.file);
console.log("  replay          工具调用 " + rp.data.calls.length + " 次,结果 " + rp.data.session.reason);
console.log("  benchmark       质量分 " + bm.data.quality + "/100 (" + bm.data.verdict + ")");
console.log("===== 链路演示 " + (okAll ? "通过 ✅" : "失败 ❌") + " =====");
process.exit(okAll ? 0 : 1);
