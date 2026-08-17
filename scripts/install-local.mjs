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
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGINS = [
  { dir: "llm-opencode-zen", patchIds: ["llm-opencode-zen"], pkg: "@3kaiu/dsh-llm-opencode-zen" },
  { dir: "harness-updater", patchIds: ["dsh-harness-updater"], pkg: "@3kaiu/dsh-harness-updater" },
  { dir: "layout-infer", patchIds: ["dsh-layout-infer"], pkg: "@3kaiu/dsh-layout-infer" },
  { dir: "dsh-console", patchIds: ["dsh-console"], pkg: "@3kaiu/dsh-console" },
  { dir: "dsh-github-sync", patchIds: ["dsh-github-sync"], pkg: "@3kaiu/dsh-github-sync" },
  { dir: "dsh-runtime-events", patchIds: ["dsh-runtime-events"], pkg: "@3kaiu/dsh-runtime-events" },
  { dir: "dsh-plugins-ui", patchIds: ["dsh-plugins-ui"], pkg: "@3kaiu/dsh-plugins-ui" },
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
for (const plugin of PLUGINS) {
  if (FROM_RELEASE) {
    const manifest = JSON.parse(readFileSync(join(root, "packages", plugin.dir, "package.json"), "utf8"));
    const tgz = manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version + ".tgz";
    const url = RELEASE_BASE + "/" + tgz;
    console.log(`\n[install-local] add ${plugin.pkg} <- ${url}`);
    // 供应链校验:先下载到临时目录,比对 GitHub Release 发布的 SHA256SUMS,
    // 通过后才交给 pnpm——不安装任何未校验的产物(仓库/CDN 被攻破时中止)。
    const tmpTgz = join(tmpdir(), "dsh-tgz", tgz);
    mkdirSync(dirname(tmpTgz), { recursive: true });
    execSync(`curl -fsSL -o "${tmpTgz}" "${url}"`, { stdio: "inherit" });
    const sumsTxt = execSync(`curl -fsSL "${RELEASE_BASE}/SHA256SUMS"`, { encoding: "utf8" });
    const want = sumsTxt.split("\n").map((l) => l.trim()).find((l) => l.endsWith("  " + tgz))?.split(/\s+/)[0];
    const got = execSync(`shasum -a 256 "${tmpTgz}"`).toString().trim().split(/\s+/)[0];
    if (!want || want !== got) {
      console.error(`[install-local] SHA-256 校验失败: ${tgz}(期望 ${want ?? "无条目"},实得 ${got});中止安装——请确认 Release 已重建(含 SHA256SUMS 资产)`);
      process.exit(1);
    }
    console.log(`[install-local] SHA-256 校验通过: ${tgz} ${got.slice(0, 12)}…`);
    execSync(`cd "${profileDir}" && pnpm add -w "${url}"`, { stdio: "inherit" });
    continue;
  }
  const abs = join(root, "packages", plugin.dir);
  // dist 必须已构建:esbuild 包看 index.js,console 是前端产物(index.html/assets),
  // 统一检查"目录非空"。
  if (!existsSync(abs) || !existsSync(join(abs, "dist")) || readdirSync(join(abs, "dist")).length === 0) {
    console.error(`dist missing for ${plugin.pkg}; run pnpm build first`);
    process.exit(1);
  }
  console.log(`\n[install-local] add ${plugin.pkg} (${abs})`);
  // profile 自身就是 pnpm workspace 根(dsh 生成),add 需要 -w 显式确认;
  // 必须 cd 进 profile: pnpm 的 workspace 检测跟随 shell cwd。
  execSync(`cd "${profileDir}" && pnpm add -w "file:${abs}"`, { stdio: "inherit" });
}

// 2. 清理旧 install.mjs 写入的无 scope 依赖条目(dsh-llm-opencode-zen 等)
const pkgFile = join(profileDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
const stale = Object.keys(pkg.dependencies ?? {}).filter((name) =>
  ["dsh-llm-opencode-zen", "dsh-harness-updater", "dsh-layout-infer"].includes(name));
for (const name of stale) delete pkg.dependencies[name];

// 3. reconcile bundles: 声明了 dsh.bundle 的依赖按依赖顺序加入 dsh.profile.bundles
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
