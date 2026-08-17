#!/usr/bin/env node
// morning-report.mjs —— 维护早报:report --json 转 markdown(状态总览 + 发行门禁 + 回归告警 + 待办 + 运行痕迹)
// 用法: node scripts/morning-report.mjs [--stdout] [--out <path>](默认 .dsh/state/morning-report.md)
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.DSH_MAINT_REPO ?? process.cwd());
// 发行包布局(dsh-maint 与早报同目录)优先;仓库布局兜底
const BIN = existsSync(join(__dir, "dsh-maint", "bin", "dsh-maint.mjs")) ? join(__dir, "dsh-maint", "bin", "dsh-maint.mjs") : resolve("packages/dsh-maintenance-core/bin/dsh-maint.mjs");
const rp = JSON.parse(execSync("node " + BIN + " report --json", { cwd: REPO, encoding: "utf8", env: { ...process.env, DSH_MAINT_REPO: REPO } }));
if (!rp.ok) { console.error("report 失败: " + (rp.diagnostics ?? []).join("; ")); process.exit(1); }
const d = rp.data;
const L = [];
L.push("# 维护早报 " + new Date().toISOString().slice(0, 10));
L.push("");
L.push("## 状态总览");
L.push("- 事项: **" + d.incidents.open + " open** / " + d.incidents.fixed + " fixed");
L.push("- 发行门禁: " + (d.score.gate.pass ? "✅ 通过" : "❌ 未过") + "(阈值 " + d.score.gate.threshold + ",最新评分 " + (d.score.last?.quality ?? "-") + ")");
if (d.incidents.openList.length) {
  L.push("");
  L.push("## 待办");
  for (const i of d.incidents.openList) L.push("- ⚠ [" + i.id + "] " + i.title + "(" + (i.taxonomy ?? "?") + ")");
}
const regs = [];
for (const b of d.score.byIncident) for (const rg of b.regressions) regs.push({ id: b.id, ...rg });
if (regs.length) {
  L.push("");
  L.push("## 回归告警");
  for (const rg of regs) L.push("- ⚠ " + rg.id + ": " + rg.from + "→" + rg.to + " 主因 " + rg.cause);
}
L.push("");
L.push("## 运行痕迹");
L.push("- Agent Score: " + d.score.runs + " 次,avg " + d.score.avgQuality + ",趋势 " + d.score.byIncident.map((b) => "[" + b.trend.join("→") + "]").join(" "));
L.push("- 恢复点: " + (d.checkpoints.length ? d.checkpoints.join(", ") : "无"));
L.push("- 知识: " + d.knowledgeFiles + " 条");
L.push("");
L.push("---");
L.push("*由 dsh-maint report 生成(11 篇 §19)*");
const md = L.join("\n") + "\n";
if (process.argv.includes("--stdout")) { console.log(md); process.exit(0); }
const idx = process.argv.indexOf("--out");
const outPath = resolve(idx >= 0 ? process.argv[idx + 1] : REPO + "/.dsh/state/morning-report.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md);
console.log("早报已生成: " + outPath);
