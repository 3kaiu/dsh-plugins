#!/usr/bin/env node
// dshctl.mjs —— 发行层生命周期工具(04 篇 §6 增量计划第 1 项落地)
// 用法: node scripts/dshctl.mjs console start|stop|status|open [--harness]
// 环境: DSH_CONSOLE_PORT(默认 3090) DSH_MAINT_REPO(默认当前目录) DSHCTL_OPEN_PRINT=1(不真的 open,打印 URL)
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = resolve(process.env.DSH_MAINT_REPO ?? process.cwd());
const PORT = Number(process.env.DSH_CONSOLE_PORT ?? 3090);
const STATE_DIR = join(homedir(), ".local", "state", "dsh-runtime");
const PID_FILE = join(STATE_DIR, "console.pid");
const LOG_FILE = join(STATE_DIR, "console.log");
const SERVER = join(REPO, "packages", "dsh-console", "server.mjs");
const require = createRequire(import.meta.url);

function readPid() { try { return Number(readFileSync(PID_FILE, "utf8")) || 0; } catch { return 0; } }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function probe() {
  const http = require("node:http");
  return new Promise((res) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/health/summary", timeout: 2000 }, (r) => {
      let body = ""; r.on("data", (d) => (body += d)); r.on("end", () => { try { res({ ok: r.statusCode === 200, body: JSON.parse(body) }); } catch { res({ ok: false, body: null }); } });
    });
    req.on("error", () => res({ ok: false, body: null }));
    req.on("timeout", () => { req.destroy(); res({ ok: false, body: null }); });
  });
}

const cmd = process.argv[2];
const sub = process.argv[3];
const extra = process.argv.slice(4);
if (cmd !== "console") { console.error("用法: dshctl console start|stop|status|open [--harness]"); process.exit(1); }
if (sub === "start") {
  const pid = readPid();
  if (alive(pid)) { console.log("console 已在运行(pid " + pid + ",端口 " + PORT + ")"); process.exit(0); }
  mkdirSync(STATE_DIR, { recursive: true });
  const out = require("node:fs").openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, DSH_CONSOLE_PORT: String(PORT), DSH_MAINT_REPO: REPO } });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 15; i++) {
    const p = await probe();
    if (p.ok) { console.log("console 已启动(pid " + child.pid + ",端口 " + PORT + ",事件库 " + (p.body?.seq ?? 0) + " 条)"); process.exit(0); }
    await sleep(200);
  }
  console.error("console 启动超时,日志: " + LOG_FILE);
  process.exit(1);
}
if (sub === "stop") {
  const pid = readPid();
  if (!alive(pid)) { console.log("console 未在运行"); rmSync(PID_FILE, { force: true }); process.exit(0); }
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 15; i++) {
    const p = await probe();
    if (!p.ok) { rmSync(PID_FILE, { force: true }); console.log("console 已停止(pid " + pid + ")"); process.exit(0); }
    await sleep(200);
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  rmSync(PID_FILE, { force: true });
  console.log("console 已强制停止(pid " + pid + ")");
  process.exit(0);
}
if (sub === "status") {
  const pid = readPid();
  const p = await probe();
  if (alive(pid) && p.ok) {
    const b = p.body;
    console.log("console: 运行中(pid " + pid + ",端口 " + PORT + ")");
    console.log("  事件库目录: " + b.eventsDir);
    console.log("  最新 seq: " + b.seq);
    process.exit(0);
  }
  if (alive(pid)) { console.log("console: pid " + pid + " 存活但端口 " + PORT + " 无响应"); process.exit(1); }
  console.log("console: 未运行(pid 文件 " + (existsSync(PID_FILE) ? "存在但进程已退出" : "不存在") + ")");
  process.exit(1);
}
if (sub === "open") {
  const target = extra.includes("--harness") ? "http://127.0.0.1:3080" : "http://127.0.0.1:" + PORT;
  if (process.env.DSHCTL_OPEN_PRINT === "1") { console.log("open " + target); process.exit(0); }
  try { execSync("open " + target); console.log("已打开: " + target); } catch { console.log("请手动打开: " + target); }
  process.exit(0);
}
console.error("未知子命令: " + sub);
process.exit(1);
