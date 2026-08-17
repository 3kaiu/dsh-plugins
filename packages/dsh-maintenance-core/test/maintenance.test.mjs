// dsh-maintenance-core 单测:解析/排序/契约/工具
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseMiniYaml } from "../lib/yaml-mini.mjs";
import { loadIncidents, sortIncidents, scoreOf } from "../lib/incidents.mjs";
import { loadContract, checkDiff } from "../lib/contract.mjs";

let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok -", name); };

console.log("# yaml-mini");
{
  const y = parseMiniYaml(`
# 注释
version: 1
agent:
  provider: opencode-zen
  model: deepseek-v4-flash-free
repair:
  max_attempts: 3
  max_runtime: 15m
permissions:
  allow: [packages/**, docs/**]
  deny: [.github/workflows/release.yml, "**/package.json"]
`);
  assert.equal(y.version, 1);
  assert.equal(y.agent.provider, "opencode-zen");
  assert.equal(y.repair.max_attempts, 3);
  assert.equal(y.repair.max_runtime, "15m");
  assert.deepEqual(y.permissions.allow, ["packages/**", "docs/**"]);
  assert.deepEqual(y.permissions.deny, [".github/workflows/release.yml", "**/package.json"]);
  ok("嵌套 map + 行内列表 + 标量");
}

console.log("# incidents 排序");
{
  const repo = mkdtempSync(join(tmpdir(), "inc-repo-"));
  const dir = join(repo, ".dsh", "incidents");
  mkdirSync(dir, { recursive: true });
  const write = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o));
  write("a.json", { id: "INC-001", severity: "LOW", frequency: 1, title: "a" });
  write("b.json", { id: "INC-002", severity: "CRITICAL", frequency: 1, title: "b" });
  write("c.json", { id: "INC-003", severity: "MEDIUM", frequency: 5, title: "c" });
  write("bad.json", "{not json");
  const incs = loadIncidents(repo);
  assert.equal(incs.length, 3);
  const sorted = sortIncidents(incs);
  assert.equal(sorted[0].id, "INC-003"); // 2×5=10
  assert.equal(sorted[1].id, "INC-002"); // 8×1=8
  assert.equal(sorted[2].id, "INC-001"); // 1×1=1
  assert.equal(scoreOf(sorted[0]), 10);
  ok("严重度权重×频率排序,坏文件跳过");
}

console.log("# contract 默认值 + diff 检查");
{
  const c = loadContract("/nonexistent");
  assert.equal(c.budget.maxAttemptsPerIssue, 3);
  assert.equal(c.budget.maxChangedFiles, 15);
  const good = checkDiff(["packages/llm-opencode-zen/src/index.js", "docs/architecture/05-roadmap.md"], c);
  assert.ok(good.checks.every((x) => x.result === "pass"));
  const bad = checkDiff([".github/workflows/release.yml", "packages/a/b.js"], c);
  assert.equal(bad.checks.find((x) => x.name === "no_forbidden_paths").result, "fail");
  ok("deny 命中 release.yml");
  const many = checkDiff(Array.from({ length: 20 }, (_, i) => "packages/p" + i + "/x.js"), c);
  assert.equal(many.checks.find((x) => x.name === "max_changed_files").result, "fail");
  ok("max_changed_files=15 触发");
}

console.log("# 六工具冒烟(仓库内)")
{
  const { execSync } = await import("node:child_process");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const run = (args) => JSON.parse(execSync("node packages/dsh-maintenance-core/bin/dsh-maint.mjs " + args, { cwd: root, encoding: "utf8" }));
  const st = run("status --json");
  assert.equal(st.ok, true);
  assert.ok(st.data.incidents.length >= 1);
  assert.equal(st.data.incidents[0].id, "INC-20260817-001");
  const ins = run("inspect INC-20260817-001 --json");
  assert.equal(ins.data.incident.id, "INC-20260817-001");
  const rep = run("reproduce INC-20260817-001 --json");
  assert.equal(rep.data.reproduced, false); // README 已合入 main(PR #4/#5)→ 不可复现
  const vf = run("verify contract --json");
  assert.equal(vf.ok, true);
  ok("status/inspect/reproduce/verify 契约冒烟");
}

console.log("# evidence 证据核验(假完成拦截)");
{
  const { execSync } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "ev-repo-"));
  const incDir = join(repo, ".dsh", "incidents");
  mkdirSync(incDir, { recursive: true });
  writeFileSync(join(incDir, "inc-001.json"), JSON.stringify({
    id: "INC-TEST-001", title: "x.txt 应存在且含 FIXED", severity: "LOW", frequency: 1,
    taxonomy: "FAKE", status: "open",
    reproduce: { command: "node -e \"process.exit(require('fs').existsSync('x.txt') ? 1 : 0)\"", workdir: "." },
    testCommand: "node -e \"const t=require('fs').readFileSync('x.txt','utf8');if(!t.includes('FIXED'))process.exit(1);console.log('ok')\""
  }));
  execSync("git init -q && git config user.email maint-test@local && git config user.name maint-test && git add -A && git commit -qm base", { cwd: repo });
  const runEv = (claim) => JSON.parse(execSync(
    "node " + fileURLToPath(new URL("../bin/dsh-maint.mjs", import.meta.url)) + " verify evidence --claim " + claim + " --incident INC-TEST-001 --json",
    { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo, DSH_MAINT_DIFF_BASE: "HEAD" } }));
  const claimOf = (o) => { const p = join(repo, "claim.json"); writeFileSync(p, JSON.stringify(o)); return p; };

  // A: 谎报完成(声明改了,实际没改)
  const a = runEv(claimOf({ incidentId: "INC-TEST-001", changedFiles: ["x.txt"], summary: "修好了" }));
  assert.equal(a.ok, false);
  const aCheck = (n) => a.data.checks.find((c) => c.name === n).result;
  assert.equal(aCheck("claimed_files_in_diff"), "fail");
  assert.equal(aCheck("reproduce_not_reproducible"), "fail");
  assert.equal(aCheck("test_passed"), "fail");
  ok("A 谎报完成 → 拦截(声明文件不在 diff + 缺陷仍可复现 + 测试失败)");

  // B: 改了文件但缺陷仍在(改错文件 y.txt,x.txt 缺失)
  writeFileSync(join(repo, "y.txt"), "hello");
  execSync("git add y.txt", { cwd: repo });
  const b = runEv(claimOf({ incidentId: "INC-TEST-001", changedFiles: ["y.txt"], summary: "改了 y.txt" }));
  assert.equal(b.ok, false);
  assert.equal(b.data.checks.find((c) => c.name === "reproduce_not_reproducible").result, "fail");
  ok("B 改错文件 → 拦截(reproduce 仍可复现)");
  // 清理 B 的 y.txt,避免残留在后续 diff(未声明文件检查)
  execSync("git reset -q HEAD -- y.txt && rm y.txt", { cwd: repo });

  // C: 改了目标文件但测试没过(内容缺 FIXED)
  writeFileSync(join(repo, "x.txt"), "not fixed");
  execSync("git add x.txt", { cwd: repo });
  const c = runEv(claimOf({ incidentId: "INC-TEST-001", changedFiles: ["x.txt"], summary: "已创建 x.txt" }));
  assert.equal(c.ok, false);
  assert.equal(c.data.checks.find((x) => x.name === "test_passed").result, "fail");
  ok("C 测试未过 → 拦截");

  // D: 真实修复(内容含 FIXED)→ 放行
  writeFileSync(join(repo, "x.txt"), "FIXED done");
  execSync("git add x.txt", { cwd: repo });
  const d = runEv(claimOf({ incidentId: "INC-TEST-001", changedFiles: ["x.txt"], summary: "x.txt 已含 FIXED,reproduce 转不可复现,test 通过" }));
  assert.equal(d.ok, true);
  ok("D 真实修复 → 放行(全部核验 pass)");
}
console.log("# replay 深度回放(修复前后对比)");
{
  const { execSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  const BIN = fileURLToPath(new URL("../bin/dsh-maint.mjs", import.meta.url));
  // 修复前 trace:五族包络形态(失败现场)
  const before = [
    { seq: 1, type: "session.started", at: "2026-08-17T03:00:00.000Z", sessionId: "s1", data: { title: "修复 README 缺失" } },
    { seq: 2, type: "request/context", at: "2026-08-17T03:00:01.000Z", sessionId: "s1", data: { provider: "deepseek", model: "deepseek-chat", contextWindow: 131072 } },
    { seq: 3, type: "turn/start", at: "2026-08-17T03:00:02.000Z", sessionId: "s1", data: {} },
    { seq: 4, type: "tool.started", at: "2026-08-17T03:00:03.000Z", sessionId: "s1", data: { tool: "bash", inputSummary: "ls docs" } },
    { seq: 5, type: "tool.completed", at: "2026-08-17T03:00:04.000Z", sessionId: "s1", data: { tool: "bash", exitCode: 1, latencyMs: 512, stdoutTail: "README 缺失" } },
    { seq: 6, type: "error.recorded", at: "2026-08-17T03:00:05.000Z", sessionId: "s1", data: { taxonomy: "REPRODUCE_FAILED", severity: "LOW", occurrences: 2 } },
    { seq: 7, type: "llm/retry", at: "2026-08-17T03:00:06.000Z", sessionId: "s1", data: { error: "rate limited" } },
    { seq: 8, type: "session.completed", at: "2026-08-17T03:00:10.000Z", sessionId: "s1", data: { reason: "failed", turns: 3, tokens: { in: 1200, out: 340 }, durationMs: 10000 } }
  ].map((e) => JSON.stringify(e)).join("\n");
  const beforePath = join(dir, "before.jsonl");
  writeFileSync(beforePath, before + "\n");
  // 修复后 trace:原始 firehose 形态(成功现场)
  const after = [
    { type: "session.started", at: "2026-08-17T03:30:00.000Z", data: { title: "修复 README 缺失(重试)" } },
    { type: "tool/call", at: "2026-08-17T03:30:01.000Z", data: { name: "bash", arguments: "ls docs" } },
    { type: "tool/result", at: "2026-08-17T03:30:02.000Z", data: { exitCode: 0, message: { content: ["README.md"] } } },
    { type: "session.completed", at: "2026-08-17T03:30:05.000Z", data: { reason: "completed", turns: 1, tokens: { in: 900, out: 120 } } }
  ].map((e) => JSON.stringify(e)).join("\n");
  const afterPath = join(dir, "after.jsonl");
  writeFileSync(afterPath, after + "\n");
  const runReplay = (args) => JSON.parse(execSync("node " + BIN + " " + args, { cwd: dir, encoding: "utf8" }));
  // 1) 五族形态深度回放
  const rp = runReplay("replay " + beforePath + " --json");
  assert.equal(rp.data.exists, true);
  assert.equal(rp.data.session.model, "deepseek-chat");
  assert.equal(rp.data.session.reason, "failed");
  assert.equal(rp.data.session.turns, 3);
  assert.equal(rp.data.calls.length, 1);
  assert.equal(rp.data.calls[0].tool, "bash");
  assert.equal(rp.data.calls[0].exitCode, 1);
  assert.equal(rp.data.calls[0].output, "README 缺失");
  assert.equal(rp.data.errors[0].taxonomy, "REPRODUCE_FAILED");
  assert.equal(rp.data.llmRetries, 1);
  assert.ok(rp.data.timeline.length >= 6);
  ok("replay 五族形态:会话元数据/工具配对/错误聚合/timeline");
  // 2) 原始形态回放
  const ra = runReplay("replay " + afterPath + " --json");
  assert.equal(ra.data.calls[0].tool, "bash");
  assert.equal(ra.data.calls[0].exitCode, 0);
  assert.equal(ra.data.calls[0].output, '["README.md"]'); // 结构化 content 原样 JSON 化
  assert.equal(ra.data.session.reason, "completed");
  ok("replay 原始形态:tool/call+tool/result 配对");
  // 3) 修复前后对比
  const df = runReplay("replay --before " + beforePath + " --after " + afterPath + " --json");
  assert.equal(df.data.exists, true);
  assert.deepEqual(df.data.seqA, ["bash"]);
  assert.deepEqual(df.data.seqB, ["bash"]);
  assert.equal(df.data.changes.length, 0);
  assert.equal(df.data.resultChanges[0].exitCode, "1 → 0");
  assert.equal(df.data.errors.total, "2 → 0");
  assert.equal(df.data.reason.before, "failed");
  assert.equal(df.data.reason.after, "completed");
  ok("replay 对比:工具序列一致、结果 1→0、错误 2→0、failed→completed");
  // 4) 不存在的 trace
  const miss = runReplay("replay nope.jsonl --json");
  assert.equal(miss.data.exists, false);
  ok("replay 不存在 trace → exists=false");
}

console.log("\npassed", passed, "checks");
