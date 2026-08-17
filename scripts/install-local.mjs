#!/usr/bin/env node
// install-local: 把 workspace 内的四个插件包装进本地 web profile。
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
//     从 GitHub Release 下载 tarball 安装(URL 直装,无需本地构建/发布)
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGINS = [
  { dir: "llm-opencode-zen", patchIds: ["llm-opencode-zen"], pkg: "@3kaiu/dsh-llm-opencode-zen" },
  { dir: "harness-updater", patchIds: ["dsh-harness-updater"], pkg: "@3kaiu/dsh-harness-updater" },
  { dir: "layout-infer", patchIds: ["dsh-layout-infer"], pkg: "@3kaiu/dsh-layout-infer" },
  { dir: "dsh-console", patchIds: ["dsh-console"], pkg: "@3kaiu/dsh-console" },
  { dir: "dsh-github-sync", patchIds: ["dsh-github-sync"], pkg: "@3kaiu/dsh-github-sync" },
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
    execSync(`cd "${profileDir}" && pnpm add -w "${url}"`, { stdio: "inherit" });
    continue;
  }
  const abs = join(root, "packages", plugin.dir);
  // dist 必须已构建:esbuild 包看 index.js,console 是前端产物(index.html/assets),
  // 统一检查"目录非空"。
  if (!existsSync(abs) || !existsSync(join(abs, "dist")) || readdirSync(join(abs, "dist")).length === 0) {
    console.error(`dist missing for ${plugin.pkg}; run \`pnpm build\` first`);
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
  const abs = local ? spec.slice("file:".length) : join(profileDir, "node_modules", name);
  if (!local && !existsSync(join(abs, "package.json"))) continue;
  if (local && !existsSync(join(abs, "package.json"))) continue;
  const manifest = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
  if (manifest.dsh?.bundle?.patch === void 0) continue;
  if (!bundles.includes(name)) bundles.push(name);
}
pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } };
if (Object.keys(pkg.dependencies ?? {}).length === 0) delete pkg.dependencies;
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
if (stale.length > 0) console.log(`[install-local] removed stale deps: ${stale.join(", ")}`);
console.log(`[install-local] dsh.profile.bundles: ${bundles.join(", ")}`);

// 4. 从 profile patch 移除插件条目(bundle 层 patch 已注册,避免双注册)
function removeEntries(patch, ids) {
  const targets = new Set(ids);
  const lines = patch.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*- id: (.+?)\s*$/.exec(lines[i]);
    if (m !== null && targets.has(m[1].trim())) {
      const indent = lines[i].match(/^\s*/)[0].length;
      i++;
      while (i < lines.length) {
        const cur = lines[i];
        if (cur.trim() === "") { i++; continue; }
        if (cur.match(/^\s*/)[0].length <= indent) { i--; break; }
        i++;
      }
      continue;
    }
    out.push(lines[i]);
  }
  // 清理因此变空的 insert 块
  return out.join("\n").replace(/\n- insert:\s*\n(?=\n|$)/g, "\n");
}
// 用户 patch 层可能尚不存在(launcher 生成过 profile 但从未编辑过 patch)
const patch = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
const cleaned = removeEntries(patch, PLUGINS.flatMap((p) => p.patchIds));
if (cleaned !== patch) {
  writeFileSync(patchFile, cleaned);
  console.log(`[install-local] removed plugin entries from ${patchFile}`);
}

// 5. 收敛安装
execSync(`cd "${profileDir}" && pnpm install`, { stdio: "inherit" });

console.log(`
[install-local] done. Notes:
  - 插件注册由 bundle 机制提供: profile.dsh.profile.bundles 已含 @3kaiu/*,
    每个包的 cordis.patch.yml 在启动时作为 bundle 层 patch 应用;
  - 旧的手工安装目录(~/.dsh/plugins/dsh-llm-opencode-zen 等)不再被引用,可手动删除;
  - 修改在下次启动 dsh web 时生效(或由 HMR 热加载);
  - ${FROM_RELEASE ? "当前为 Release 模式(--release):更新 = git pull && node scripts/install-local.mjs --release" : "当前为源码模式:更新 = git pull && pnpm build && node scripts/install-local.mjs"}`);
