// dsh-maintenance-core 单测:解析/排序/契约/工具
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
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
  // 排序:严重度权重×频率(INC-20260817-003 MEDIUM 应排在最前)
  assert.equal(st.data.incidents[0].id, "INC-20260817-003");
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
console.log("# benchmark Agent 行为指标(修复前后对比)");
{
  const { execSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const BIN = fileURLToPath(new URL("../bin/dsh-maint.mjs", import.meta.url));
  const ev = (o) => JSON.stringify(o);
  // before:失败现场(2 次调用 1 败 + 2 重试 + 1 类错误)
  writeFileSync(join(dir, "before.jsonl"), [
    ev({ type: "session.started", at: "2026-08-17T04:00:00.000Z", data: { title: "修复 x" } }),
    ev({ type: "tool.started", at: "2026-08-17T04:00:01.000Z", data: { tool: "bash", inputSummary: "a" } }),
    ev({ type: "tool.completed", at: "2026-08-17T04:00:02.000Z", data: { tool: "bash", exitCode: 0, latencyMs: 100, stdoutTail: "ok" } }),
    ev({ type: "tool.started", at: "2026-08-17T04:00:03.000Z", data: { tool: "bash", inputSummary: "b" } }),
    ev({ type: "tool.completed", at: "2026-08-17T04:00:04.000Z", data: { tool: "bash", exitCode: 1, latencyMs: 300, stdoutTail: "ERR" } }),
    ev({ type: "error.recorded", at: "2026-08-17T04:00:05.000Z", data: { taxonomy: "REPRODUCE_FAILED", severity: "LOW", occurrences: 2 } }),
    ev({ type: "llm/retry", at: "2026-08-17T04:00:06.000Z", data: {} }),
    ev({ type: "llm/retry", at: "2026-08-17T04:00:07.000Z", data: {} }),
    ev({ type: "session.completed", at: "2026-08-17T04:00:10.000Z", data: { reason: "failed", turns: 2 } })
  ].join("\n") + "\n");
  // after:成功现场(2 次调用全 0 退出,无重试无错误)
  writeFileSync(join(dir, "after.jsonl"), [
    ev({ type: "session.started", at: "2026-08-17T04:30:00.000Z", data: { title: "修复 x(重试)" } }),
    ev({ type: "tool.started", at: "2026-08-17T04:30:01.000Z", data: { tool: "bash", inputSummary: "a" } }),
    ev({ type: "tool.completed", at: "2026-08-17T04:30:02.000Z", data: { tool: "bash", exitCode: 0, latencyMs: 90, stdoutTail: "ok" } }),
    ev({ type: "tool.started", at: "2026-08-17T04:30:03.000Z", data: { tool: "bash", inputSummary: "b" } }),
    ev({ type: "tool.completed", at: "2026-08-17T04:30:04.000Z", data: { tool: "bash", exitCode: 0, latencyMs: 80, stdoutTail: "done" } }),
    ev({ type: "session.completed", at: "2026-08-17T04:30:06.000Z", data: { reason: "completed", turns: 1 } })
  ].join("\n") + "\n");
  const runB = (args) => JSON.parse(execSync("node " + BIN + " " + args, { cwd: dir, encoding: "utf8" }));
  // 1) 失败现场指标
  const bf = runB("benchmark before.jsonl --json");
  assert.equal(bf.data.exists, true);
  assert.equal(bf.data.metrics.toolCalls, 2);
  assert.equal(bf.data.metrics.failedCalls, 1);
  assert.equal(bf.data.metrics.failureRate, 0.5);
  assert.equal(bf.data.metrics.llmRetries, 2);
  assert.equal(bf.data.metrics.errorDensity, 1); // 2 次错误 / 2 次调用
  assert.equal(bf.data.metrics.reason, "failed");
  assert.equal(bf.data.quality, 10); // 1 - 失败率0.5 - 重试0.15×2 - 错误密度0.1×1 = 0.1 → 10
  assert.equal(bf.data.verdict, "poor");
  ok("benchmark 失败现场:失败率/重试/错误密度/质量分");
  // 2) 成功现场指标
  const af = runB("benchmark after.jsonl --json");
  assert.equal(af.data.metrics.failedCalls, 0);
  assert.equal(af.data.metrics.failureRate, 0);
  assert.equal(af.data.metrics.reason, "completed");
  assert.equal(af.data.quality, 100);
  assert.equal(af.data.verdict, "good");
  ok("benchmark 成功现场:全 0 退出 → 质量分 100/good");
  // 3) 修复前后对比
  const cp = runB("benchmark --before before.jsonl --after after.jsonl --json");
  assert.equal(cp.data.exists, true);
  assert.equal(cp.data.deltas.failureRate.delta, -0.5);
  assert.equal(cp.data.deltas.llmRetries.delta, -2);
  assert.equal(cp.data.deltas.quality.delta, 90); // 100 - 10
  assert.equal(cp.data.verdict.before, "poor");
  assert.equal(cp.data.verdict.after, "good");
  assert.ok(cp.data.verdict.improved.includes("failureRate"));
  ok("benchmark 对比:失败率 0.5→0、重试 2→0、质量 20→100,poor→good");
  // 4) 探测失败不计失败率(read exit 1 + bash exit 0 → failureRate 0)
  const probe = join(dir, "probe.jsonl");
  writeFileSync(probe, [
    { seq: 1, type: "session.started", at: "2026-08-17T03:00:00.000Z", sessionId: "p1", data: { title: "t" } },
    { seq: 2, type: "turn/start", at: "2026-08-17T03:00:01.000Z", sessionId: "p1", data: {} },
    { seq: 3, type: "tool.started", at: "2026-08-17T03:00:02.000Z", sessionId: "p1", data: { tool: "read", inputSummary: "missing.txt" } },
    { seq: 4, type: "tool.completed", at: "2026-08-17T03:00:03.000Z", sessionId: "p1", data: { tool: "read", exitCode: 1, latencyMs: 5, stdoutTail: "ENOENT" } },
    { seq: 5, type: "tool.started", at: "2026-08-17T03:00:04.000Z", sessionId: "p1", data: { tool: "bash", inputSummary: "echo x > missing.txt" } },
    { seq: 6, type: "tool.completed", at: "2026-08-17T03:00:05.000Z", sessionId: "p1", data: { tool: "bash", exitCode: 0, latencyMs: 8, stdoutTail: "" } },
    { seq: 7, type: "session.completed", at: "2026-08-17T03:00:06.000Z", sessionId: "p1", data: { reason: "completed", turns: 1 } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const pr = runB("benchmark " + probe + " --json");
  assert.equal(pr.data.metrics.failedCalls, 0);
  assert.equal(pr.data.metrics.failureRate, 0);
  assert.equal(pr.data.quality, 100);
  ok("benchmark:探测失败(read exit 1)不计失败率,质量分 100");
  // 5) 不存在
  const miss = runB("benchmark nope.jsonl --json");
  assert.equal(miss.data.exists, false);
  ok("benchmark 不存在 trace → exists=false");
console.log("# checkpoint 恢复点(Recovery 最小可用版)");
{
  const { execSync } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "ckpt-"));
  const incDir = join(repo, ".dsh", "incidents");
  mkdirSync(incDir, { recursive: true });
  writeFileSync(join(incDir, "inc-ckpt.json"), JSON.stringify({
    id: "INC-CKPT-001", title: "ckpt 测试事项", severity: "LOW", frequency: 1, taxonomy: "TEST", status: "open",
    reproduce: { command: "node -e \"process.exit(1)\"", workdir: "." },
    testCommand: "node -e \"process.exit(0)\""
  }));
  const stDir = join(repo, ".dsh", "state");
  mkdirSync(stDir, { recursive: true });
  writeFileSync(join(stDir, "attempts.jsonl"), JSON.stringify({ incidentId: "INC-CKPT-001", attempt: 1, at: "2026-08-17T05:00:00.000Z" }) + "\n");
  const kDir = join(repo, ".dsh", "knowledge");
  mkdirSync(kDir, { recursive: true });
  writeFileSync(join(kDir, "ckpt-notes.md"), "# 备忘");
  execSync("git init -q && git config user.email maint-test@local && git config user.name maint-test && git add -A && git commit -qm base", { cwd: repo });
  const BIN = fileURLToPath(new URL("../bin/dsh-maint.mjs", import.meta.url));
  const runCk = (args) => JSON.parse(execSync("node " + BIN + " " + args, { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo } }));
  // 1) 创建恢复点
  const cr = runCk("checkpoint INC-CKPT-001 --json");
  assert.equal(cr.ok, true);
  assert.ok(cr.data.checkpoint.id.startsWith("INC-CKPT-001-"));
  assert.equal(cr.data.checkpoint.incidentId, "INC-CKPT-001");
  assert.equal(cr.data.checkpoint.attempts, 1); // attempts.jsonl 1 条
  assert.deepEqual(cr.data.checkpoint.knowledge, ["ckpt-notes.md"]);
  assert.ok(cr.data.checkpoint.git.head.length === 40);
  ok("checkpoint create:快照含事项全文/attempts/知识/git head");
  const snapId = cr.data.checkpoint.id;
  // 2) 列出恢复点
  const ls = runCk("checkpoint list --json");
  assert.equal(ls.data.checkpoints.length, 1);
  assert.equal(ls.data.checkpoints[0].id, snapId);
  ok("checkpoint list:能列出已创建快照");
  // 3) 恢复点读取 + 完整性验证
  const rs = runCk("checkpoint restore " + snapId + " --json");
  assert.equal(rs.data.restored, true);
  assert.deepEqual(rs.data.missing, []);
  assert.equal(rs.data.snapshot.incident.title, "ckpt 测试事项");
  ok("checkpoint restore:完整性验证通过,现场可恢复");
  // 4) 不存在的快照
  const miss = runCk("checkpoint restore nope --json");
  assert.equal(miss.data.restored, false);
  ok("checkpoint restore 不存在 → restored=false");
}
console.log("# knowledge 沉淀 + fixtures 兼容契约");
{
  const { execSync } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "know-"));
  const incDir = join(repo, ".dsh", "incidents");
  mkdirSync(incDir, { recursive: true });
  writeFileSync(join(incDir, "inc-know.json"), JSON.stringify({
    id: "INC-KNOW-001", title: "knowledge 测试", severity: "LOW", frequency: 1, taxonomy: "TEST", status: "open",
    reproduce: { command: "node -e \"process.exit(0)\"", workdir: "." },
    testCommand: "node -e \"process.exit(0)\"",
    knowledge: "内嵌知识:这类问题先看 events JSONL"
  }));
  execSync("git init -q && git config user.email maint-test@local && git config user.name maint-test && git add -A && git commit -qm base", { cwd: repo });
  const BIN = fileURLToPath(new URL("../bin/dsh-maint.mjs", import.meta.url));
  const runK = (args) => JSON.parse(execSync("node " + BIN + " " + args, { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo } }));
  const TXT = "经验:reproduce 探测要用 existsSync";
  // 1) 沉淀经验
  const ad = runK("knowledge add INC-KNOW-001 --text \"" + TXT + "\" --json");
  assert.equal(ad.data.added, true);
  assert.equal(ad.data.file, "INC-KNOW-001.md");
  assert.ok(readFileSync(join(repo, ".dsh", "knowledge", "INC-KNOW-001.md"), "utf8").includes(TXT));
  // 2) 去重
  const dup = runK("knowledge add INC-KNOW-001 --text \"" + TXT + "\" --json");
  assert.equal(dup.data.added, false);
  const content = readFileSync(join(repo, ".dsh", "knowledge", "INC-KNOW-001.md"), "utf8");
  assert.equal(content.split(TXT).length - 1, 1); // 只出现一次
  // 3) 查询:内嵌 + 文件
  const q = runK("knowledge INC-KNOW-001 --json");
  assert.equal(q.data.embedded, "内嵌知识:这类问题先看 events JSONL");
  assert.ok(q.data.files.includes("INC-KNOW-001.md"));
  assert.ok(q.data.notes[0].content.includes(TXT));
  // 4) 列表
  const ls = runK("knowledge list --json");
  assert.ok(ls.data.files.includes("INC-KNOW-001.md"));
  assert.equal(ls.data.embedded.length, 1);
  ok("knowledge 沉淀/去重/查询/列表");
  // 5) fixtures:复制样例到 tmp 仓库,loadIncidents/loadContract 可解析
  const fx = fileURLToPath(new URL("../../../.dsh/fixtures", import.meta.url));
  for (const f of ["inc-open.json", "inc-fixed.json"]) {
    writeFileSync(join(incDir, f), readFileSync(join(fx, "incidents", f), "utf8"));
  }
  writeFileSync(join(repo, ".dsh", "autopilot.yml"), readFileSync(join(fx, "autopilot.yml"), "utf8"));
  const { loadIncidents: li2 } = await import("../lib/incidents.mjs");
  const { loadContract: lc2 } = await import("../lib/contract.mjs");
  const incs = li2(repo);
  assert.ok(incs.some((i) => i.id === "INC-FIXTURE-OPEN-001" && i.status === "open"));
  assert.ok(incs.some((i) => i.id === "INC-FIXTURE-FIXED-001" && i.status === "fixed" && i.mergedRefs.length === 1));
  const c = lc2(repo);
  assert.equal(c.budget.maxRunsPerDay, 3);
  assert.equal(c.budget.maxAttemptsPerIssue, 3);
  assert.equal(c.budget.maxRuntimeMin, "15"); // yaml-mini 解析为字符串(既有行为)
  ok("fixtures 兼容契约:incidents(open/fixed)+ autopilot.yml 均可解析");
}
console.log("# guarded auto-merge 判定(Phase 3)");
{
  const repo = mkdtempSync(join(tmpdir(), "guard-"));
  writeFileSync(join(repo, "seed.txt"), "x");
  execSync("git init -q && git config user.email maint-test@local && git config user.name maint-test && git add -A && git commit -qm base", { cwd: repo });
  const BIN = fileURLToPath(new URL("../bin/dsh-maint.mjs", import.meta.url));
  const runG = (mockFile) => JSON.parse(execSync("node " + BIN + " guard --mock " + mockFile + " --json", { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo } }));
  const mkMock = (f, o) => writeFileSync(join(repo, f), JSON.stringify(o));
  // 1) 放行:维护分支 + verified + attempts 1 + CI 全绿
  mkMock("allow.json", { number: 42, headRefName: "maintenance/INC-X-20260817-000000", labels: [{ name: "verified" }], body: "Agent 自动修复(INC-X)\n\nattempts: 1", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
  const al = runG(join(repo, "allow.json"));
  assert.equal(al.data.allowMerge, true);
  assert.deepEqual(al.data.reasons, []);
  ok("guard 放行:维护分支+verified+attempts<3+CI 全绿 → allowMerge");
  // 2) 拦截:needs-human
  mkMock("deny-human.json", { number: 43, headRefName: "maintenance/INC-Y-20260817-000000", labels: [{ name: "verified" }, { name: "needs-human" }], body: "attempts: 2", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
  const dh = runG(join(repo, "deny-human.json"));
  assert.equal(dh.data.allowMerge, false);
  assert.ok(dh.data.reasons.some((r) => r.includes("needs-human")));
  ok("guard 拦截:needs-human 标签 → 不合并");
  // 3) 拦截:attempts ≥ 3(budget 上限)
  mkMock("deny-attempts.json", { number: 44, headRefName: "maintenance/INC-Z-20260817-000000", labels: [{ name: "verified" }], body: "attempts: 3", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
  const da = runG(join(repo, "deny-attempts.json"));
  assert.equal(da.data.allowMerge, false);
  assert.ok(da.data.reasons.some((r) => r.includes("attempts=3")));
  ok("guard 拦截:attempts=3 达 budget 上限 → 不合并");
  // 4) 拦截:非维护分支 + CI blocked
  mkMock("deny-branch.json", { number: 45, headRefName: "feature/INC-W", labels: [{ name: "verified" }], body: "attempts: 1", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" });
  const db = runG(join(repo, "deny-branch.json"));
  assert.equal(db.data.allowMerge, false);
  assert.ok(db.data.reasons.some((r) => r.includes("非维护分支")));
  assert.ok(db.data.reasons.some((r) => r.includes("CI 未全绿")));
  ok("guard 拦截:非维护分支 + CI blocked → 双原因拦截");
}
console.log("# Agent Score/Analytics/归因(Phase 4)");
{
  const repo = mkdtempSync(join(tmpdir(), "score-"));
  writeFileSync(join(repo, "seed.txt"), "x");
  const incDir = join(repo, ".dsh", "incidents");
  mkdirSync(incDir, { recursive: true });
  writeFileSync(join(incDir, "inc-score.json"), JSON.stringify({ id: "INC-SCORE-001", title: "score 测试", severity: "LOW", frequency: 1, taxonomy: "DOC_MISSING", status: "fixed" }));
  execSync("git init -q && git config user.email maint-test@local && git config user.name maint-test && git add -A && git commit -qm base", { cwd: repo });
  const BIN = fileURLToPath(new URL("../bin/dsh-maint.mjs", import.meta.url));
  const runS = (args) => JSON.parse(execSync("node " + BIN + " " + args, { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo } }));
  // 1) benchmark --record 落盘
  const good = join(repo, "good.jsonl");
  writeFileSync(good, [
    { seq: 1, type: "session.started", at: "2026-08-17T05:00:00.000Z", sessionId: "g1", data: { title: "t" } },
    { seq: 2, type: "turn/start", at: "2026-08-17T05:00:01.000Z", sessionId: "g1", data: {} },
    { seq: 3, type: "tool.started", at: "2026-08-17T05:00:02.000Z", sessionId: "g1", data: { tool: "bash", inputSummary: "fix" } },
    { seq: 4, type: "tool.completed", at: "2026-08-17T05:00:03.000Z", sessionId: "g1", data: { tool: "bash", exitCode: 0, latencyMs: 10, stdoutTail: "ok" } },
    { seq: 5, type: "session.completed", at: "2026-08-17T05:00:05.000Z", sessionId: "g1", data: { reason: "completed", turns: 1 } }
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r1 = runS("benchmark " + good + " --record --incident INC-SCORE-001 --json");
  assert.equal(r1.data.recorded.runs, 1);
  assert.ok(existsSync(join(repo, ".dsh", "state", "benchmarks", "INC-SCORE-001.json")));
  // 2) 再记录一次(累积)
  const r2 = runS("benchmark " + good + " --record --incident INC-SCORE-001 --json");
  assert.equal(r2.data.recorded.runs, 2);
  ok("benchmark --record:评分落盘且累积");
  // 3) score 聚合
  const sc = runS("score --json");
  assert.equal(sc.data.runs, 2);
  assert.equal(sc.data.avgQuality, 100);
  assert.deepEqual(sc.data.byIncident[0].trend, [100, 100]);
  assert.equal(sc.data.byTaxonomy[0].taxonomy, "DOC_MISSING");
  ok("score 聚合:runs/avg/trend/taxonomy");
  // 4) 归因:注入下降记录(90→60,失败率 +0.4 主导)
  writeFileSync(join(repo, ".dsh", "state", "benchmarks", "INC-SCORE-001.json"), JSON.stringify([
    { at: "2026-08-17T05:10:00.000Z", trace: "a", quality: 90, verdict: "good", metrics: { failureRate: 0, llmRetries: 0, errorDensity: 0, reason: "completed" } },
    { at: "2026-08-17T06:10:00.000Z", trace: "b", quality: 60, verdict: "ok", metrics: { failureRate: 0.4, llmRetries: 0, errorDensity: 0, reason: "completed" } }
  ]));
  const sc2 = runS("score --json");
  const rg = sc2.data.byIncident[0].regressions[0];
  assert.equal(rg.from, 90);
  assert.equal(rg.to, 60);
  assert.equal(rg.cause, "failureRate");
  ok("score 归因:90→60 下降,主因 failureRate(+0.4)");
  // 5) 发行门禁:avg 75 ≥ 60 且 reason=completed → pass
  assert.equal(sc2.data.gate.pass, true);
  // 低分场景 → fail
  writeFileSync(join(repo, ".dsh", "state", "benchmarks", "INC-SCORE-001.json"), JSON.stringify([
    { at: "2026-08-17T05:10:00.000Z", trace: "a", quality: 40, verdict: "poor", metrics: { failureRate: 0.5, llmRetries: 1, errorDensity: 0, reason: "failed" } }
  ]));
  const sc3 = runS("score --gate 60 --json");
  assert.equal(sc3.data.gate.pass, false);
  ok("score 门禁:avg<60 或 reason≠completed → 不通过");
  // 6) report:状态总览 + Score 集成(tmp repo:1 fixed 事项 INC-SCORE-001、无 open/checkpoint)
  const rp = runS("report --json");
  assert.equal(rp.data.incidents.open, 0);
  assert.equal(rp.data.incidents.fixed, 1);
  assert.equal(rp.data.score.runs, 1);                // 与 score 同一聚合源
  assert.equal(rp.data.score.gate.pass, false);
  assert.equal(rp.data.checkpoints.length, 0);
  ok("report 状态总览:open/fixed 计数 + Score 集成 + 痕迹字段");
  // 7) report --gate:门禁参数透传
  const rp2 = runS("report --gate 40 --json");
  assert.equal(rp2.data.score.gate.threshold, 40);
  assert.equal(rp2.data.score.gate.pass, false);
  ok("report --gate:阈值透传(40 仍不通过:reason=failed)");
}
console.log("# 兼容健康检查 doctor(成功指标收口)");
{
  const repo = mkdtempSync(join(tmpdir(), "doctor-"));
  writeFileSync(join(repo, "seed.txt"), "x");
  const incDir = join(repo, ".dsh", "incidents");
  const fxDir = join(repo, ".dsh", "fixtures");
  const stDir = join(repo, ".dsh", "state");
  mkdirSync(incDir, { recursive: true });
  mkdirSync(fxDir, { recursive: true });
  mkdirSync(join(stDir, "benchmarks"), { recursive: true });
  mkdirSync(join(stDir, "checkpoints"), { recursive: true });
  mkdirSync(join(stDir, "traces"), { recursive: true });
  mkdirSync(join(repo, ".dsh", "knowledge"), { recursive: true });
  mkdirSync(join(repo, "docs", "architecture"), { recursive: true });
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(incDir, "inc-d.json"), JSON.stringify({ id: "INC-D-001", title: "doctor 测试", severity: "LOW", frequency: 1, taxonomy: "X", status: "open" }));
  writeFileSync(join(repo, ".dsh", "autopilot.yml"), "version: 1\nagent: { provider: opencode-zen, model: m }\nschedule: { cron: \"0 2 * * *\", tz: Asia/Shanghai }\nselection: { max_tasks_per_run: 1 }\nrepair: { max_attempts: 3, max_changed_files: 15, max_diff_lines: 500, max_runtime: 15m }\nverification: { required: [typecheck, test, regression] }\ngit: { strategy: pull_request, branch_prefix: maintenance/ }\nmerge: { mode: guarded }\npermissions:\n  allow: [packages/**, tests/**, fixtures/**, .dsh/knowledge/**, docs/**]\n  deny: [.github/workflows/release.yml, .dsh/autopilot.yml, LICENSE, secrets/**]\n");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  copyFileSync(join(root, "docs", "architecture", "09-interfaces.md"), join(repo, "docs", "architecture", "09-interfaces.md"));
  copyFileSync(join(root, ".github", "workflows", "ci.yml"), join(repo, ".github", "workflows", "ci.yml"));
  execSync("git init -q && git config user.email maint-test@local && git config user.name maint-test && git add -A && git commit -qm base", { cwd: repo });
  const BIN = fileURLToPath(new URL("../bin/dsh-maint.mjs", import.meta.url));
  const runD = (args) => JSON.parse(execSync("node " + BIN + " " + args, { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo } }));
  // 1) 健康仓库 → 100 healthy
  const d1 = runD("doctor --json");
  assert.equal(d1.data.score, 100);
  assert.equal(d1.data.verdict, "healthy");
  assert.equal(d1.data.checks.filter((c) => c.result === "pass").length, 7);
  ok("doctor:健康仓库 100/100 healthy(7/7)");
  // 2) autopilot.yml 损坏 → 契约 fail
  writeFileSync(join(repo, ".dsh", "autopilot.yml"), "version: 1\n  bad indent: [x");
  const d2 = runD("doctor --json");
  assert.equal(d2.data.score, 70);
  assert.equal(d2.data.verdict, "warning");
  ok("doctor:autopilot.yml 损坏 → 70 warning");
  // 3) 09-interfaces.md 缺失 → 工具清单 fail
  rmSync(join(repo, "docs", "architecture", "09-interfaces.md"));
  writeFileSync(join(repo, ".dsh", "autopilot.yml"), "version: 1\nagent: { provider: opencode-zen, model: m }\nschedule: { cron: \"0 2 * * *\", tz: Asia/Shanghai }\nselection: { max_tasks_per_run: 1 }\nrepair: { max_attempts: 3, max_changed_files: 15, max_diff_lines: 500, max_runtime: 15m }\nverification: { required: [typecheck, test, regression] }\ngit: { strategy: pull_request, branch_prefix: maintenance/ }\nmerge: { mode: guarded }\npermissions:\n  allow: [packages/**, tests/**, fixtures/**, .dsh/knowledge/**, docs/**]\n  deny: [.github/workflows/release.yml, .dsh/autopilot.yml, LICENSE, secrets/**]\n");
  const d3 = runD("doctor --json");
  assert.equal(d3.data.score, 80);
  assert.equal(d3.data.verdict, "warning");
  ok("doctor:09 缺失 → 工具清单 fail → 80 warning");
  // 4) incidents 空 → 15 fail
  rmSync(join(incDir, "inc-d.json"));
  copyFileSync(join(root, "docs", "architecture", "09-interfaces.md"), join(repo, "docs", "architecture", "09-interfaces.md"));
  const d4 = runD("doctor --json");
  assert.equal(d4.data.score, 85);
  assert.equal(d4.data.verdict, "warning");
  ok("doctor:incidents 空 → 85 warning");
}
}

console.log("\npassed", passed, "checks");
