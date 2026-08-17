#!/usr/bin/env node
// release.ts —— Console 工作台发行打包(TypeScript;node ≥24 原生 type-stripping 直接运行)
// 边界:本脚本只打包 plugins 仓库资产(Console PWA + 维护工具);
//       官方 Harness 生命周期与启动器属 3kaiu/dsh-launcher(dshctl),不在此包内。
// 用法: node scripts/release.ts [--version X.Y.Z] [--out dist-release]
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE = join(ROOT, "packages", "dsh-console");
const argv = process.argv.slice(2);
const pick = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const VER = pick("--version") ?? (JSON.parse(readFileSync(join(CONSOLE, "package.json"), "utf8")) as { version: string }).version;
const OUT = resolve(pick("--out") ?? join(ROOT, "dist-release"));
const STAGE = join(OUT, "dsh-workbench-" + VER);
const ZIP = join(OUT, "dsh-workbench-" + VER + ".zip");

const dist = join(CONSOLE, "dist");
for (const p of [dist, join(CONSOLE, "dist", "server.mjs")]) {
  if (!existsSync(p)) throw new Error("缺失: " + p + "(先 pnpm --filter @3kaiu/dsh-console build)");
}
const WS = join(CONSOLE, "node_modules", "ws");
if (!existsSync(WS)) throw new Error("缺失 ws 包: " + WS + "(先 pnpm install)");

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, "dsh-maint", "bin"), { recursive: true });
mkdirSync(join(STAGE, "dsh-maint", "lib"), { recursive: true });
mkdirSync(join(STAGE, "node_modules"), { recursive: true });
cpSync(dist, join(STAGE, "dist"), { recursive: true });
cpSync(join(CONSOLE, "dist", "server.mjs"), join(STAGE, "server.mjs"));
cpSync(join(ROOT, "scripts", "morning-report.mjs"), join(STAGE, "morning-report.mjs"));
cpSync(join(ROOT, "packages", "dsh-maintenance-core", "bin", "dsh-maint.mjs"), join(STAGE, "dsh-maint", "bin", "dsh-maint.mjs"));
cpSync(join(ROOT, "packages", "dsh-maintenance-core", "lib"), join(STAGE, "dsh-maint", "lib"), { recursive: true });
cpSync(WS, join(STAGE, "node_modules", "ws"), { recursive: true, dereference: true });
// 极简启动/停止脚本(发行包自身;官方 Harness 生命周期用 launcher 仓库 dshctl)
writeFileSync(join(STAGE, "start.sh"), [
"#!/usr/bin/env bash",
"# DSH Workbench:启动 Console(3090)。pid 落 ~/.local/state/dsh-runtime/console.pid",
"set -euo pipefail",
"DIR=\"$(cd \"$(dirname \"$0\")\" && pwd)\"",
"ST=\"$HOME/.local/state/dsh-runtime\"",
"mkdir -p \"$ST\"",
"if [ -f \"$ST/console.pid\" ] && kill -0 \"$(cat \"$ST/console.pid\")\" 2>/dev/null; then echo \"console 已在运行(pid $(cat \"$ST/console.pid\"))\"; exit 0; fi",
"PORT=\"${DSH_CONSOLE_PORT:-3090}\"",
"nohup node \"$DIR/server.mjs\" >> \"$ST/console.log\" 2>&1 &",
"echo $! > \"$ST/console.pid\"",
"echo \"console 已启动(pid $!,http://127.0.0.1:$PORT)\"",
].join("\n") + "\n");
writeFileSync(join(STAGE, "stop.sh"), [
"#!/usr/bin/env bash",
"ST=\"$HOME/.local/state/dsh-runtime\"",
"if [ ! -f \"$ST/console.pid\" ]; then echo \"console 未在运行\"; exit 0; fi",
"kill \"$(cat \"$ST/console.pid\")\" 2>/dev/null || true",
"rm -f \"$ST/console.pid\"",
"echo \"console 已停止\"",
].join("\n") + "\n");
writeFileSync(join(STAGE, "package.json"), JSON.stringify({
  name: "dsh-workbench", version: VER, type: "module",
  description: "DSH Workbench:Agent 工作台(Console PWA 3090 + 维护工具)",
  scripts: { start: "bash start.sh", stop: "bash stop.sh", doctor: "node dsh-maint/bin/dsh-maint.mjs doctor", report: "node dsh-maint/bin/dsh-maint.mjs report", morning: "node morning-report.mjs" },
}, null, 2) + "\n");
writeFileSync(join(STAGE, "versions.json"), JSON.stringify({
  workbench: VER, console: VER, maintenanceCore: "0.1.0",
  harness: "0.1.0-rc.6(官方 dsh CLI + dsh-launcher dshctl 提供,3080)",
  node: process.versions.node, launcher: "3kaiu/dsh-launcher(独立仓库)",
}, null, 2) + "\n");
writeFileSync(join(STAGE, "README.md"), [
"# DSH Workbench(Agent 工作台,3090)",
"",
"## 快速开始",
"",
"1. 解压本包(任意目录);",
"2. ./start.sh —— 启动 Console(pid 在 ~/.local/state/dsh-runtime/console.pid);",
"3. 浏览器打开 http://127.0.0.1:3090;",
"4. macOS Safari:文件 → 添加到程序坞(PWA 已含 manifest + Service Worker + 图标);",
"5. ./stop.sh 停止。",
"",
"## 工具",
"",
"- node dsh-maint/bin/dsh-maint.mjs doctor / report / score / guard ...(维护工具集);",
"- node morning-report.mjs(维护早报,需 DSH_MAINT_REPO 指向维护仓库);",
"- 官方 DeepSeek Harness Web(3080):由 3kaiu/dsh-launcher 的 dshctl 管理(独立仓库,下载 dsh-launcher-macos-*.zip),Safari 添加到程序坞即为全屏 Web App。",
"",
"## 边界",
"",
"- Console 仅绑定 127.0.0.1:3090;事件库读取 DSH_HOME/state/events(dsh CLI 写入);",
"- 本包不含官方代码与启动器(零 fork 零修改原则);版本与校验: versions.json + SHA256SUMS。",
].join("\n") + "\n");

rmSync(ZIP, { force: true });
execSync("cd " + OUT + " && zip -qr " + ZIP + " dsh-workbench-" + VER, { shell: "/bin/bash" });
const bytes = readFileSync(ZIP);
const sum = createHash("sha256").update(bytes).digest("hex");
writeFileSync(join(OUT, "SHA256SUMS"), sum + "  " + ZIP.split("/").pop() + "\n");
console.log("OK " + ZIP.split("/").pop() + "(" + (bytes.length / 1024).toFixed(0) + " KB)");
console.log("SHA256 " + sum);
