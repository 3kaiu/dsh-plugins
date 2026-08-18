// @3kaiu/dsh-plugins-ui node half —— PluginManager remote service
// 设置弹窗「插件 → 管理」tab 的后端:安装/卸载/升级 profile 插件。
// 语义与官方 `dsh plugin --profile web <add|remove|update>` 一致
// (pnpm + 按安装状态 reconcile dsh.profile.bundles),另加:
//   - 快捷名(内置 @3kaiu 插件)→ GitHub Release tarball;
//   - 远程 tarball 下载后先比对 Release 的 SHA256SUMS,通过才交给 pnpm;
//   - restart():spawn 自身进程并退出,让新插件加载生效。
// 暴露为 Typert remote(TypertRemoteService + @Remote 标记),api-gateway
// 的 SRC 发现机制自动认领端点,浏览器经
//   POST /api/pluginManager/<method>  +  {type:"client-request", rpcId, method, payload:{args}}
// 调用(与官方 remote 同一通道,pluginInventory/list 同款)。
// 注意:
//   - SRC 描述符从方法源码解析参数名,此文件构建时禁止 minify;
//   - 必须用函数 apply 显式实例化(类导出走 cordis 加载器路径在 bundle
//     条目下不生效,已实证);browser half 的注入不受影响。
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DSH_HOME = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const PROFILE = "web";
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const MANIFEST = join(PROFILE_DIR, "package.json");
const RELEASE_BASE = "https://github.com/3kaiu/dsh-plugins/releases/latest/download";
// 与 scripts/install-local.mjs 的 Release 资产命名一致(pnpm pack:scope 去 @、/ 转 -)
const SHORT_NAMES = {
  "llm-opencode-zen": "3kaiu-dsh-llm-opencode-zen",
  "harness-updater": "3kaiu-dsh-harness-updater",
  "layout-infer": "3kaiu-dsh-layout-infer",
  "dsh-console": "3kaiu-dsh-console",
  "dsh-github-sync": "3kaiu-dsh-github-sync",
  "dsh-runtime-events": "3kaiu-dsh-runtime-events",
  "dsh-plugins-ui": "3kaiu-dsh-plugins-ui",
};

// 商店目录:浏览器「管理」tab 的可用插件清单(名称/描述/emoji 面向用户)
const CATALOG = [
  { key: "llm-opencode-zen", pkg: "@3kaiu/dsh-llm-opencode-zen", emoji: "🦙", name: "OpenCode Zen 模型", description: "免费 DeepSeek 模型接入,可调并发/重试/模型列表" },
  { key: "dsh-github-sync", pkg: "@3kaiu/dsh-github-sync", emoji: "🔁", name: "GitHub 同步", description: "把 CI 工作流与 PR 状态拉进本地事件库" },
  { key: "dsh-runtime-events", pkg: "@3kaiu/dsh-runtime-events", emoji: "⏱️", name: "运行时事件", description: "事件采集与用量记录" },
  { key: "harness-updater", pkg: "@3kaiu/dsh-harness-updater", emoji: "🆕", name: "运行时更新", description: "检查 dsh 新版本,在 Console 提示升级" },
  { key: "dsh-console", pkg: "@3kaiu/dsh-console", emoji: "🖥️", name: "事件控制台", description: "事件库工作台(端口 3090,重启生效)" },
  { key: "layout-infer", pkg: "@3kaiu/dsh-layout-infer", emoji: "📐", name: "布局推断", description: "设计稿节点树的布局语义标注(面向开发者)" },
  { key: "dsh-plugins-ui", pkg: "@3kaiu/dsh-plugins-ui", emoji: "🧩", name: "插件设置与管理", description: "本页面的配置卡与插件管理自身" },
];

// 尽力查询 @3kaiu/dsh-plugins 最新 Release,返回 { key: tag };离线/无 Release 时为空
// 60s 内存缓存:list 每次调用都会触发,避免操作后刷新卡 3s
let latestCache = { at: 0, map: {} };
async function latestVersions() {
  if (Date.now() - latestCache.at < 60000) return latestCache.map;
  const map = {};
  try {
    const res = await fetch("https://api.github.com/repos/3kaiu/dsh-plugins/releases/latest", {
      signal: AbortSignal.timeout(3000),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "dsh-plugins-ui" },
    });
    if (!res.ok) return map;
    const rel = await res.json();
    const tag = String(rel.tag_name ?? "").replace(/^v/, "");
    if (!tag) return map;
    const assets = (rel.assets ?? []).map((a) => String(a.name ?? ""));
    for (const key of Object.keys(SHORT_NAMES)) {
      // Release 资产名 = <package-file>-<version>.tgz,各插件版本号可能不同
      const file = SHORT_NAMES[key];
      const hit = assets.find((a) => a.startsWith(file + "-"));
      if (hit) {
        const rest = hit.slice(file.length + 1);
        const m = rest.match(/^(.+)\.tgz$/);
        if (m) map[key] = m[1];
      }
    }
    latestCache = { at: Date.now(), map };
  } catch { /* 离线/超时:latest 为空,UI 不显示更新提示 */ }
  return map;
}

/** 语义化版本比较:>0 表示 a 更新 */
function compareVersions(a: string, b: string) {
  const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x !== typeof y) return typeof x === "number" ? 1 : -1;
    return typeof x === "number" ? x - y : String(x).localeCompare(String(y));
  }
  return 0;
}

function readManifest() {
  try { return JSON.parse(readFileSync(MANIFEST, "utf8")); } catch { return null; }
}
function writeManifest(m) { writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n"); }
function readPkg(dir) {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return null; }
}

/** 依赖包是否声明 dsh.bundle(官方 dsh plugin reconcile 的同款判定) */
function exportsPatch(pkg) {
  return readPkg(join(PROFILE_DIR, "node_modules", pkg))?.dsh?.bundle?.patch !== undefined;
}

/** 按安装状态对齐 dsh.profile.bundles(依赖声明 dsh.bundle 则加入,否则摘除) */
function reconcilePlugins() {
  const m = readManifest();
  if (!m) throw new Error("web profile 不存在: " + PROFILE_DIR);
  const deps = Object.keys(m.dependencies ?? {});
  const plugins = new Set(m.dsh?.profile?.bundles ?? []);
  for (const dep of deps) if (exportsPatch(dep)) plugins.add(dep);
  for (const p of [...plugins]) if (!deps.includes(p) || !exportsPatch(p)) plugins.delete(p);
  m.dsh ??= {};
  m.dsh.profile ??= {};
  m.dsh.profile.bundles = [...plugins];
  writeManifest(m);
  return [...plugins];
}

/** 运行 pnpm(PATH 优先,退回 npx --yes pnpm@9.15.0,覆盖未全局装 pnpm 的 launcher 环境) */
function runPnpm(args) {
  const probe = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  const bin = probe.status === 0 ? "pnpm" : "npx";
  const full = bin === "npx" ? ["--yes", "pnpm@9.15.0", ...args] : args;
  const r = spawnSync(bin, full, { cwd: PROFILE_DIR, encoding: "utf8", timeout: 300000 });
  const text = [r.stdout, r.stderr].filter(Boolean).join("\n");
  return { ok: r.status === 0, text, status: r.status };
}

/** 下载 tarball 并比对 Release 的 SHA256SUMS。
 * 匹配规则:资产名精确匹配,或剥掉 `-<版本>` 段后匹配(快捷名场景资产名带版本)。
 * 3kaiu Release 域的 URL 必须校验通过(否则拒绝);第三方 URL 无法比对时如实标注未校验。 */
async function fetchVerified(url, { mandatory }) {
  const fileName = basename(decodeURIComponent(url.split("/").pop() ?? "download.tgz"));
  const file = join(PROFILE_DIR, ".dsh-downloads", fileName);
  mkdirSync(join(file, ".."), { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error("下载失败: " + url + " (HTTP " + res.status + ")");
  const buf = Buffer.from(await res.arrayBuffer());
  let expected;
  try {
    const sums = await fetch(RELEASE_BASE + "/SHA256SUMS", { signal: AbortSignal.timeout(30000) });
    if (sums.ok) {
      for (const line of (await sums.text()).split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const asset = parts.slice(1).join(" ");
        const bare = asset.replace(/\.tgz$/, "").replace(/-\d[^/]*$/, "") + ".tgz";
        if (asset === fileName || bare === fileName) { expected = parts[0]; break; }
      }
    }
  } catch { /* 校验文件不可达:按 mandatory 决定拒绝或标注 */ }
  const got = createHash("sha256").update(buf).digest("hex");
  if (expected) {
    if (got !== expected.toLowerCase()) {
      throw new Error("SHA-256 校验失败: " + fileName + "(期望 " + expected.slice(0, 12) + "…,实得 " + got.slice(0, 12) + "…)");
    }
  } else if (mandatory) {
    throw new Error("SHA-256 校验清单不可达或缺少该资产,已拒绝安装(官方来源必须校验通过)");
  }
  writeFileSync(file, buf);
  return { file, verified: expected !== undefined };
}

/** PluginManager remote service(浏览器「插件 → 管理」tab 的后端) */
export class PluginManagerGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "pluginManager");
  }

  /** 插件总览:商店目录(可用/已装/可升级)+ 全部已装依赖 */
  @Remote("list")
  async list() {
    const m = readManifest();
    const deps = Object.keys(m?.dependencies ?? {});
    const bundles = m?.dsh?.profile?.bundles ?? [];
    const installed = deps.map((name) => {
      const pkg = readPkg(join(PROFILE_DIR, "node_modules", name));
      return {
        name,
        version: pkg?.version ?? null,
        description: pkg?.description ?? null,
        bundle: bundles.includes(name),
        hasBundleDecl: exportsPatch(name),
      };
    });
    const latest = await latestVersions();
    const catalog = CATALOG.map((entry) => {
      const inst = installed.find((p) => p.name === entry.pkg);
      const version = inst?.version ?? null;
      const latestVersion = latest[entry.key] ?? null;
      return {
        ...entry,
        installed: !!inst,
        version,
        latest: latestVersion,
        hasUpdate: !!inst && !!latestVersion && compareVersions(latestVersion, version) > 0,
      };
    });
    return { profile: PROFILE, dshHome: DSH_HOME, bundles, installed, catalog };
  }

  /** 安装:快捷名 / https tarball(SHA-256 校验后交给 pnpm)/ file: 路径 / 包名 */
  @Remote("install")
  async install(spec) {
    const s = String(spec ?? "").trim();
    if (!s) throw new Error("请输入插件包名、GitHub 下载地址或本地路径");
    if (s.startsWith("-")) throw new Error("参数不能以 - 开头(防 pnpm 旗标注入)");
    let arg = s;
    const notes = [];
    if (SHORT_NAMES[s] !== undefined) {
      arg = RELEASE_BASE + "/" + SHORT_NAMES[s] + ".tgz";
      notes.push("快捷名 → " + arg);
    }
    if (/^https?:\/\//.test(arg)) {
      if (!/\.(tgz|tar\.gz)$/.test(arg)) throw new Error("远程地址需要指向 .tgz 文件");
      const mandatory = arg.startsWith(RELEASE_BASE);
      const { file, verified } = await fetchVerified(arg, { mandatory });
      arg = file;
      notes.push(verified ? "已下载并通过 SHA-256 校验" : "已下载,但不在官方 SHA-256 清单中(未校验)");
    } else if (arg.startsWith("file:")) {
      arg = arg.slice("file:".length);
    }
    const r = runPnpm(["add", "-w", arg]);
    if (!r.ok) throw new Error("pnpm add 失败:\n" + r.text.slice(-2000));
    const bundles = reconcilePlugins();
    return { ok: true, note: notes.join("; "), installed: arg, bundles, output: r.text.slice(-400) };
  }

  /** 卸载 */
  @Remote("uninstall")
  uninstall(pkg) {
    const name = String(pkg ?? "").trim();
    if (!name) throw new Error("缺少包名");
    if (name.startsWith("-")) throw new Error("参数不能以 - 开头(防 pnpm 旗标注入)");
    const r = runPnpm(["remove", "-w", name]);
    if (!r.ok) throw new Error("pnpm remove 失败:\n" + r.text.slice(-2000));
    const bundles = reconcilePlugins();
    return { ok: true, removed: name, bundles };
  }

  /** 升级:全部(仅 semver 范围)或单个(file:/URL 依赖 pnpm update 不重拉,改卸载+重装原 spec) */
  @Remote("update")
  update(pkg) {
    const name = String(pkg ?? "").trim();
    if (name.startsWith("-")) throw new Error("参数不能以 - 开头(防 pnpm 旗标注入)");
    if (name) {
      const m = readManifest();
      const spec = m?.dependencies?.[name];
      if (spec !== undefined && !/^[~^]?\d/.test(String(spec))) {
        const rm = runPnpm(["remove", "-w", name]);
        if (!rm.ok) throw new Error("pnpm remove 失败:\n" + rm.text.slice(-2000));
        const add = runPnpm(["add", "-w", String(spec)]);
        if (!add.ok) throw new Error("pnpm add 失败:\n" + add.text.slice(-2000));
        const bundles = reconcilePlugins();
        return { ok: true, updated: name, reinstalled: true, bundles };
      }
    }
    const args = ["update", "-w", ...(name ? [name] : [])];
    const r = runPnpm(args);
    if (!r.ok) throw new Error("pnpm update 失败:\n" + r.text.slice(-2000));
    const bundles = reconcilePlugins();
    return { ok: true, updated: name || "all", bundles };
  }

  /** 重启 dsh web(安装/卸载/升级后生效) */
  @Remote("restart")
  restart() {
    const logPath = join(DSH_HOME, ".dsh-restart.log");
    const logFd = openSync(logPath, "a", 0o600);
    writeSync(logFd, "[" + new Date().toISOString() + "] restart called, pid=" + process.pid + "\n");
    // 延迟 2s 再 exec 自身:给当前进程 800ms 退出与端口释放留出时间,
    // 避免子进程启动期绑同端口撞 EADDRINUSE(sh -c 包装:先 sleep 后 exec)。
    const child = spawn("sh", ["-c", `sleep 2; exec "$0" "$@"`, process.execPath, process.argv[1], ...process.argv.slice(2)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, DSH_WEB_RESTARTING: "1" },
    });
    child.unref();
    const selfPid = process.pid;
    setTimeout(() => { try { process.exit(0); } catch { /* 已退出 */ } }, 800);
    return { restarted: true, childPid: child.pid, selfPid };
  }
}

// 显式 apply 实例化:类导出走 cordis 加载器路径在 bundle 条目下不生效
// (已实证);函数插件路径与其余 @3kaiu 插件一致,可正常加载。
export function apply(ctx) {
  new PluginManagerGateway(ctx);
}

export default PluginManagerGateway;
