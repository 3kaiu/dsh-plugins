// dsh-maintenance-core 单测:解析/排序/契约/工具
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const root = "/Users/seeu/dev/dsh-opencode-zen";
  const run = (args) => JSON.parse(execSync("node packages/dsh-maintenance-core/bin/dsh-maint.mjs " + args, { cwd: root, encoding: "utf8" }));
  const st = run("status --json");
  assert.equal(st.ok, true);
  assert.ok(st.data.incidents.length >= 1);
  assert.equal(st.data.incidents[0].id, "INC-20260817-001");
  const ins = run("inspect INC-20260817-001 --json");
  assert.equal(ins.data.incident.id, "INC-20260817-001");
  const rep = run("reproduce INC-20260817-001 --json");
  assert.equal(rep.data.reproduced, true); // README 缺失 → 退出 0 → 可复现
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
  execSync("git init -q && git add -A && git commit -qm base", { cwd: repo });
  const runEv = (claim) => JSON.parse(execSync(
    "node /Users/seeu/dev/dsh-opencode-zen/packages/dsh-maintenance-core/bin/dsh-maint.mjs verify evidence --claim " + claim + " --incident INC-TEST-001 --json",
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

console.log("\npassed", passed, "checks");
