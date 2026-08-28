#!/usr/bin/env node
// install-local: 把 workspace 内的插件包装进本地 web profile。
//
// 与官方分发对齐(等价于发布后 `dsh plugin --profile web add <pkg>`):
// 1. `pnpm add file:<abs>` 把包装进 profile 的 node_modules;
// 2. 把声明了 `dsh.bundle` 的依赖 reconcile 进 profile 的
//    `dsh.profile.bundles`(dsh plugin 命令在 add 后自动做的事,这里手动做,
//    因为 pnpm 9+ 在 workspace 根的 add 需要 -w,而 dsh plugin 转发不传);
// 3. 从 profile 的 cordis.patch.yml 移除旧的插件条目(插件注册改由 bundle
//    层 patch 提供,避免同一 id 双注册);
// 4. 清理旧 install.mjs 写入的无 scope 依赖条目。
//
// 用法:
//   本地源码模式:先 `pnpm build`,再 `node scripts/install-local.mjs`
//   Release 模式(推荐,免构建):`node scripts/install-local.mjs --release`
//     从 GitHub Release 下载 tarball 安装(下载后先做 SHA-256 校验,通过才
//     交给 pnpm;Release 需为重建后的产物,含 SHA256SUMS 资产)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGINS = [
  { dir: "llm-opencode-zen", patchIds: ["llm-opencode-zen"], pkg: "@3kaiu/dsh-llm-opencode-zen" },
  { dir: "layout-infer", patchIds: ["dsh-layout-infer"], pkg: "@3kaiu/dsh-layout-infer" },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM_RELEASE = process.argv.includes("--release");
const RELEASE_BASE = process.env.DSH_PLUGIN_RELEASE_BASE ?? "https://github.com/3kaiu/dsh-plugins/releases/latest/download";
const dshHome = process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", "web");
const patchFile = join(profileDir, "cordis.patch.yml");

if (!existsSync(join(profileDir, "package.json"))) {
  console.error(`web profile not found: ${profileDir}`);
  process.exit(1);
}

// 1. 安装依赖
// 优先走官方 `dsh plugin --profile <name> add <pkg>`(0.1.1+ CLI 已修 pnpm -w 转发,
// 自动完成 bundle reconcile 与 manifest 维护);CLI 缺失或失败时回退到手搓路径。
const dshCliAvailable = spawnSync("dsh", ["--version"], { encoding: "utf8" }).status === 0;
const cliAdd = (spec, label) => {
  console.log(`[install-local] dsh plugin add ${label} <- ${spec}`);
  // pnpm 在 profile 目录 add 会误判 workspace root(0.1.1-rc.2 CLI 未传 -w),
  // 用 ignore-workspace-root-check 解锁官方路径;仅影响本次子进程。
  const r = spawnSync("dsh", ["plugin", "--profile", "web", "add", spec], {
    stdio: "inherit",
    env: { ...process.env, npm_config_ignore_workspace_root_check: "true" },
  });
  if (r.status !== 0) {
    console.warn(`[install-local] dsh plugin add 失败(status=${r.status}),回退手动路径: ${label}`);
    return false;
  }
  return true;
};
const pnpmAddSync = (spec, label) => {
  // --ignore-scripts: 插件无需构建步骤, 防 tarball install 脚本执行
  console.log(`[install-local] add ${label} <- ${spec}`);
  const r = spawnSync("pnpm", ["add", "-w", "--ignore-scripts", spec], { cwd: profileDir, stdio: "inherit" });
  if(r.status!==0) throw new Error(`pnpm add 失败: ${label}`);
};
const installSpec = (spec, label) => {
  if (dshCliAvailable && cliAdd(spec, label)) return true;
  pnpmAddSync(spec, label);
  return false;
};
const fetchBuf = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "dsh-install-local" } });
  if(!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
};
for (const plugin of PLUGINS) {
  if (FROM_RELEASE) {
    const manifest = JSON.parse(readFileSync(join(root, "packages", plugin.dir, "package.json"), "utf8"));
    const tgz = manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version + ".tgz";
    const url = RELEASE_BASE + "/" + tgz;
    console.log(`\n[install-local] add ${plugin.pkg} <- ${url}`);
    const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-tgz-"));
    const tmpTgz = join(tmpRoot, tgz);
    const buf = await fetchBuf(url);
    writeFileSync(tmpTgz, buf);
    const sumsTxt = (await fetchBuf(RELEASE_BASE+"/SHA256SUMS")).toString('utf8');
    const want = sumsTxt.split("\n").map((l) => l.trim()).find((l) => l.endsWith("  " + tgz))?.split(/\s+/)[0];
    const got = createHash("sha256").update(readFileSync(tmpTgz)).digest("hex");
    if (!want || want !== got) {
      console.error(`[install-local] SHA-256 校验失败: ${tgz}(期望 ${want ?? "无条目"},实得 ${got});中止安装——请确认 Release 已重建(含 SHA256SUMS 资产)`);
      process.exit(1);
    }
    console.log(`[install-local] SHA-256 校验通过: ${tgz} ${got.slice(0, 12)}…`);
    // 安装已校验的本地文件(而非重新从网络拉取 URL, 避免校验/安装不一致 TOCTOU)
    installSpec(`file:${tmpTgz}`, plugin.pkg);
    continue;
  }
  const abs = join(root, "packages", plugin.dir);
  if (!existsSync(abs) || !existsSync(join(abs, "dist")) || readdirSync(join(abs, "dist")).length === 0) {
    console.error(`dist missing for ${plugin.pkg}; run pnpm build first`);
    process.exit(1);
  }
  console.log(`\n[install-local] add ${plugin.pkg} (${abs})`);
  installSpec(abs, plugin.pkg);
}

// 2. 清理旧 install.mjs 写入的无 scope 依赖条目(dsh-llm-opencode-zen 等)
const pkgFile = join(profileDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
const stale = Object.keys(pkg.dependencies ?? {}).filter((name) =>
  ["dsh-llm-opencode-zen", "dsh-harness-updater", "dsh-layout-infer"].includes(name));
for (const name of stale) delete pkg.dependencies[name];

// 3. reconcile bundles: 声明了 dsh.bundle 的依赖按依赖顺序加入 dsh.profile.bundles
// 供应链防护: 仅已知受信插件可注入 harness(见 TRUSTED_BUNDLES), 防任意 dsh-* 包静默 RCE。
const TRUSTED_BUNDLES = new Set([
  "@3kaiu/dsh-llm-opencode-zen",
  "@3kaiu/dsh-layout-infer",
  "@3kaiu/dsh-plugin-kit",
]);
const bundles = pkg.dsh?.profile?.bundles ?? [];
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  // file:(本地源码)或 https?:(Release tarball)都算可 reconcile 的 bundle 来源
  if (!/^(file:|https?:)/.test(spec)) continue;
  const local = spec.startsWith("file:");
  // file: 可能是相对路径(pnpm 按 profile 目录解析),统一 resolve 成绝对路径
  const abs = local ? resolve(spec.slice("file:".length)) : join(profileDir, "node_modules", name);
  if (!existsSync(join(abs, "package.json"))) continue;
  const manifest = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
  if (manifest.dsh?.bundle?.patch === void 0) continue;
  if (!TRUSTED_BUNDLES.has(name)) {
    console.warn(`[install-local] 跳过未授权 bundle(不注入 harness): ${name} — 若为新插件请在 TRUSTED_BUNDLES 显式登记`);
    continue;
  }
  if (!bundles.includes(name)) bundles.push(name);
}
pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } };
if (Object.keys(pkg.dependencies ?? {}).length === 0) delete pkg.dependencies;
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
if (stale.length > 0) console.log(`[install-local] removed stale deps: ${stale.join(", ")}`);

// 4. 从 cordis.patch.yml 移除旧插件条目(bundle 层 patch 取代注册)
const patchText = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
if (patchText.trim() !== "") {
  const lines = patchText.split("\n");
  const out = [];
  let skip = 0;
  for (const line of lines) {
    if (skip > 0) { skip -= 1; continue; }
    const hit = PLUGINS.find((p) => p.patchIds.some((id) => line.includes(id)));
    if (hit) { skip = 2; continue; }
    out.push(line);
  }
  writeFileSync(patchFile, out.join("\n"));
  console.log("[install-local] cordis.patch.yml 已清理旧插件条目");
}
console.log("\n[install-local] 完成。请重启 dsh web 会话以加载插件。");
