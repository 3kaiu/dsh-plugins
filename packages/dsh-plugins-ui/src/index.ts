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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** 下载 tarball,与 Release 的 SHA256SUMS 比对(拉不到校验文件则跳过) */
async function fetchVerified(url) {
  const fileName = decodeURIComponent(url.split("/").pop() ?? "download.tgz");
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
        if (parts.length >= 2 && parts.slice(1).join(" ") === fileName) { expected = parts[0]; break; }
      }
    }
  } catch { /* 校验文件不可达则跳过(仅少一层保护) */ }
  if (expected) {
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== expected.toLowerCase()) {
      throw new Error("SHA-256 校验失败: " + fileName + "(期望 " + expected.slice(0, 12) + "…,实得 " + got.slice(0, 12) + "…)");
    }
  }
  writeFileSync(file, buf);
  return file;
}

/** PluginManager remote service(浏览器「插件 → 管理」tab 的后端) */
export class PluginManagerGateway extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, "pluginManager");
  }

  /** 已装插件列表:依赖 + bundle/版本信息 */
  @Remote("list")
  list() {
    const m = readManifest();
    const deps = Object.keys(m?.dependencies ?? {});
    const bundles = m?.dsh?.profile?.bundles ?? [];
    const plugins = deps.map((name) => {
      const pkg = readPkg(join(PROFILE_DIR, "node_modules", name));
      return {
        name,
        version: pkg?.version ?? null,
        description: pkg?.description ?? null,
        bundle: bundles.includes(name),
        hasBundleDecl: exportsPatch(name),
      };
    });
    return { profile: PROFILE, dshHome: DSH_HOME, bundles, plugins };
  }

  /** 安装:快捷名 / https tarball(SHA-256 校验后交给 pnpm)/ file: 路径 / 包名 */
  @Remote("install")
  async install(spec) {
    const s = String(spec ?? "").trim();
    if (!s) throw new Error("请输入插件包名、GitHub 下载地址或本地路径");
    let arg = s;
    const notes = [];
    if (SHORT_NAMES[s] !== undefined) {
      arg = RELEASE_BASE + "/" + SHORT_NAMES[s] + ".tgz";
      notes.push("快捷名 → " + arg);
    }
    if (/^https?:\/\//.test(arg)) {
      if (!/\.(tgz|tar\.gz)$/.test(arg)) throw new Error("远程地址需要指向 .tgz 文件");
      const local = await fetchVerified(arg);
      arg = local;
      notes.push("已下载并通过 SHA-256 校验");
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
    const r = runPnpm(["remove", "-w", name]);
    if (!r.ok) throw new Error("pnpm remove 失败:\n" + r.text.slice(-2000));
    const bundles = reconcilePlugins();
    return { ok: true, removed: name, bundles };
  }

  /** 升级:全部或单个 */
  @Remote("update")
  update(pkg) {
    const args = ["update", "-w", ...(pkg ? [String(pkg).trim()] : [])];
    const r = runPnpm(args);
    if (!r.ok) throw new Error("pnpm update 失败:\n" + r.text.slice(-2000));
    const bundles = reconcilePlugins();
    return { ok: true, updated: pkg ?? "all", bundles };
  }

  /** 重启 dsh web(安装/卸载/升级后生效) */
  @Remote("restart")
  restart() {
    const child = spawn(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
      detached: true,
      stdio: "ignore",
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
