#!/usr/bin/env node
// incidents.mjs —— 本地事件 → 维护事项/Issue(闭环第一段)
// 扫描 DSH_HOME/state/events/error.jsonl(error.recorded 包络),按 taxonomy 聚合:
//  1) 更新/新建 .dsh/incidents/<id>.json(--write 才写盘)
//  2) 确保 GitHub 有对应 open issue(label: maintenance,标题 [INC-xxx])(非 --dry-run)
// 用法:
//   node scripts/incidents.mjs [--home <DSH_HOME>] [--write] [--dry-run]
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const home = args.includes("--home") ? args[args.indexOf("--home") + 1] : (process.env.DSH_HOME?.length ? process.env.DSH_HOME : join(homedir(), ".dsh"));
const writeDisk = args.includes("--write");
const dryRun = args.includes("--dry-run");
const REPO = process.env.DSH_MAINT_REPO ?? process.cwd();
const ERR_LOG = join(home, "state", "events", "error.jsonl");
const INC_DIR = join(REPO, ".dsh", "incidents");

function now() { return new Date().toISOString(); }
// 数组参数 + execFileSync:不走 shell,title/body/搜索词里的任何字符
// (引号、$()、反引号等)都不会被当作命令执行 —— 错误消息来自 LLM/工具
// 输出,属于不可信数据,绝不能拼进命令字符串。
function sh(args) {
  try { return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (e) { return (e.stdout ?? "") + (e.stderr ?? ""); }
}

//#region 读取聚合
const groups = new Map();
if (existsSync(ERR_LOG)) {
  for (const line of readFileSync(ERR_LOG, "utf8").split("\n").filter(Boolean)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.family !== "error" || e.type !== "error.recorded") continue;
    const d = e.data ?? {};
    const taxonomy = String(d.taxonomy ?? "UNKNOWN");
    const severity = String(d.severity ?? "LOW");
    const key = taxonomy + "|" + severity;
    const g = groups.get(key) ?? { taxonomy, severity, occurrences: 0, firstAt: e.at, lastAt: e.at, message: String(d.message ?? "") };
    g.occurrences += Number(d.occurrences) || 1;
    if (e.at < g.firstAt) g.firstAt = e.at;
    if (e.at > g.lastAt) g.lastAt = e.at;
    if (!g.message && d.message) g.message = String(d.message);
    groups.set(key, g);
  }
}
//#endregion

//#region 对齐 incidents 注册表
const existing = [];
if (existsSync(INC_DIR)) for (const f of readdirSync(INC_DIR)) {
  if (!f.endsWith(".json")) continue;
  try { existing.push(JSON.parse(readFileSync(join(INC_DIR, f), "utf8"))); } catch {}
}
const used = new Set();
const out = [];
for (const g of groups.values()) {
  const match = existing.find((i) => i.taxonomy === g.taxonomy);
  let inc;
  if (match) {
    inc = { ...match, frequency: Math.max(1, (match.frequency ?? 1) + 1), lastSeenAt: g.lastAt, status: match.status ?? "open" };
    used.add(match.id);
  } else {
    const stamp = g.firstAt.slice(0, 10).replace(/-/g, "");
    const n = String(existing.length + 1).padStart(3, "0");
    inc = {
      id: "INC-" + stamp + "-" + n,
      title: g.taxonomy + ":" + g.message.slice(0, 60),
      severity: g.severity, frequency: 1, taxonomy: g.taxonomy, status: "open",
      firstSeenAt: g.firstAt, lastSeenAt: g.lastAt,
      traceRef: "state/events/error.jsonl",
      reproduce: { command: "", workdir: "." },
      testCommand: "",
      knowledge: "由 scripts/incidents.mjs 从运行时 error.recorded 自动建档",
    };
  }
  out.push({ inc, group: g });
}
//#endregion

console.log("事件库:", ERR_LOG);
console.log("聚合分组:", groups.size, "| 注册表对齐:", out.length, "| write:", writeDisk, "| dry-run:", dryRun);
for (const { inc, group } of out) {
  const line = "  " + inc.id + " [" + inc.severity + " ×" + inc.frequency + "] " + inc.taxonomy + " ×" + group.occurrences + " — " + inc.title;
  console.log(line);
  if (writeDisk) {
    writeFileSync(join(INC_DIR, inc.id.toLowerCase() + ".json"), JSON.stringify(inc, null, 2) + "\n");
    console.log("    → 已写 " + join(INC_DIR, inc.id.toLowerCase() + ".json"));
  }
}

//#region GitHub issue 对齐
if (!dryRun) {
  for (const { inc } of out) {
    const title = "[" + inc.id + "] " + inc.title;
    const found = sh(["issue", "list", "--state", "open", "--label", "maintenance", "--search", inc.id, "--json", "number", "--jq", ".[0].number // empty"]);
    if (found) {
      console.log("  issue 已存在 #" + found + "(" + title + ")");
    } else {
      const body = [
        "## 维护事项 " + inc.id,
        "",
        "- 严重度: " + inc.severity,
        "- 频次: " + inc.frequency,
        "- taxonomy: " + inc.taxonomy,
        "- 首次: " + inc.firstSeenAt,
        "- 最近: " + inc.lastSeenAt,
        "- 消息: " + inc.message,
        "",
        "> 自动建档自运行时 error.recorded(scripts/incidents.mjs)。",
        "> 维护循环:maintenance workflow 每日扫描 → Agent 修复 → PR → 人工 merge。",
      ].join("\n");
      const num = sh(["issue", "create", "--label", "maintenance", "--title", title, "--body", body]);
      console.log("  → 已创建 issue: " + num);
    }
  }
}
if (dryRun) console.log("(--dry-run:未写盘、未动 GitHub)");
console.log("完成");
