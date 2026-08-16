#!/usr/bin/env node
// 假完成拦截演示(Phase 2 Verification):4 个场景跑 evidence 闸门
// 用法: node scripts/demo-fake-completion.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const BIN = new URL("../packages/dsh-maintenance-core/bin/dsh-maint.mjs", import.meta.url).pathname;
const repo = mkdtempSync(join(tmpdir(), "fakecompletion-"));
mkdirSync(join(repo, ".dsh", "incidents"), { recursive: true });
writeFileSync(join(repo, ".dsh", "incidents", "inc-001.json"), JSON.stringify({
  id: "INC-DEMO-001", title: "demo.txt 应存在且含 FIXED", severity: "LOW", frequency: 1,
  taxonomy: "FAKE", status: "open",
  reproduce: { command: "node -e \"process.exit(require('fs').existsSync('demo.txt') ? 1 : 0)\"", workdir: "." },
  testCommand: "node -e \"const t=require('fs').readFileSync('demo.txt','utf8');if(!t.includes('FIXED'))process.exit(1)\"",
}));
execSync("git init -q && git add -A && git commit -qm base", { cwd: repo, stdio: "ignore" });

const runEv = (claim) => {
  writeFileSync(join(repo, "claim.json"), JSON.stringify(claim));
  const out = execSync(
    "node " + BIN + " verify evidence --claim " + join(repo, "claim.json") + " --incident INC-DEMO-001 --json",
    { cwd: repo, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: repo, DSH_MAINT_DIFF_BASE: "HEAD" } });
  return JSON.parse(out);
};
const verdict = (j) => (j.ok ? "放行 ✅" : "拦截 ⛔");

console.log("假完成拦截演示(evidence 闸门, 4 场景):");
console.log("");

// 场景 1:只输出 SUMMARY,磁盘无任何修改(纯嘴炮)
const s1 = runEv({ incidentId: "INC-DEMO-001", changedFiles: ["demo.txt"], summary: "修好了" });
console.log("1. 谎报完成(声明改 demo.txt,实际未动)      → " + verdict(s1));

// 场景 2:改了文件,但改错对象(缺陷仍在)
writeFileSync(join(repo, "other.txt"), "hello");
execSync("git add other.txt", { cwd: repo, stdio: "ignore" });
const s2 = runEv({ incidentId: "INC-DEMO-001", changedFiles: ["other.txt"], summary: "改了 other.txt" });
console.log("2. 改错文件(demo.txt 仍缺失,缺陷可复现)      → " + verdict(s2));
execSync("git reset -q HEAD -- other.txt && rm other.txt", { cwd: repo });

// 场景 3:目标文件改了,但回归测试不过(内容缺 FIXED)
writeFileSync(join(repo, "demo.txt"), "not fixed");
execSync("git add demo.txt", { cwd: repo, stdio: "ignore" });
const s3 = runEv({ incidentId: "INC-DEMO-001", changedFiles: ["demo.txt"], summary: "已创建 demo.txt" });
console.log("3. 文件已改但测试未过(内容缺 FIXED)          → " + verdict(s3));

// 场景 4:真实修复(内容含 FIXED,声明与实际一致)
writeFileSync(join(repo, "demo.txt"), "FIXED done");
execSync("git add demo.txt", { cwd: repo, stdio: "ignore" });
const s4 = runEv({ incidentId: "INC-DEMO-001", changedFiles: ["demo.txt"], summary: "demo.txt 已含 FIXED,reproduce 转不可复现,test 通过" });
console.log("4. 真实修复(声明一致 + reproduce/test 通过)   → " + verdict(s4));

console.log("");
console.log("闸门要求全部满足: 声明文件在 diff 中 + reproduce 转不可复现 + test 通过 + 契约合规");
rmSync(repo, { recursive: true, force: true });
process.exit(s1.ok || s2.ok || s3.ok || !s4.ok ? 1 : 0);