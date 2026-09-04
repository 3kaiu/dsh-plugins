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
// reconcile/下载校验公共核在 ./install-shared.mjs(与 install-remote 共用)。
//
// 用法:
//   本地源码模式:先 `pnpm build`,再 `node scripts/install-local.mjs`
//   Release 模式(推荐,免构建):`node scripts/install-local.mjs --release`
//     从 GitHub Release 下载 tarball 安装(下载后先做 SHA-256 校验,通过才
//     交给 pnpm;Release 需为重建后的产物,含 SHA256SUMS 资产)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBuf, parseSums, pnpmAdd, reconcileProfile, resolveProfileDir, sha256Guard } from "./install-shared.mjs";

const LOG = "[install-local]";
const PLUGINS = [
  { dir: "llm-opencode-zen", patchIds: ["llm-opencode-zen"], pkg: "@3kaiu/dsh-llm-opencode-zen" },
  { dir: "layout-infer", patchIds: ["dsh-layout-infer"], pkg: "@3kaiu/dsh-layout-infer" },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FROM_RELEASE = process.argv.includes("--release");
const RELEASE_BASE = process.env.DSH_PLUGIN_RELEASE_BASE ?? "https://github.com/3kaiu/dsh-plugins/releases/latest/download";
const profileDir = resolveProfileDir();
const patchIds = PLUGINS.flatMap((p) => p.patchIds);

if (!existsSync(join(profileDir, "package.json"))) {
  console.error(`web profile not found: ${profileDir}`);
  process.exit(1);
}

// 1. 安装依赖
// 优先走官方 `dsh plugin --profile <name> add <pkg>`(0.1.1+ CLI 已修 pnpm -w 转发,
// 自动完成 bundle reconcile 与 manifest 维护);CLI 缺失或失败时回退到手搓路径。
const dshCliAvailable = spawnSync("dsh", ["--version"], { encoding: "utf8" }).status === 0;
const cliAdd = (spec, label) => {
  console.log(`${LOG} dsh plugin add ${label} <- ${spec}`);
  // pnpm 在 profile 目录 add 会误判 workspace root(0.1.1-rc.2 CLI 未传 -w),
  // 用 ignore-workspace-root-check 解锁官方路径;仅影响本次子进程。
  const r = spawnSync("dsh", ["plugin", "--profile", "web", "add", spec], {
    stdio: "inherit",
    env: { ...process.env, npm_config_ignore_workspace_root_check: "true" },
  });
  if (r.status !== 0) {
    console.warn(`${LOG} dsh plugin add 失败(status=${r.status}),回退手动路径: ${label}`);
    return false;
  }
  return true;
};
const installSpec = (spec, label) => {
  if (dshCliAvailable && cliAdd(spec, label)) return true;
  pnpmAdd(profileDir, spec, label, LOG);
  return false;
};
for (const plugin of PLUGINS) {
  if (FROM_RELEASE) {
    const manifest = JSON.parse(readFileSync(join(root, "packages", plugin.dir, "package.json"), "utf8"));
    const tgz = manifest.name.replace("@", "").replace("/", "-") + "-" + manifest.version + ".tgz";
    const url = RELEASE_BASE + "/" + tgz;
    console.log(`\n${LOG} add ${plugin.pkg} <- ${url}`);
    // 随机后缀临时目录: 防止已知固定路径被本地攻击者预建为符号链接(TOCTOU/任意写)
    const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-tgz-"));
    const tmpTgz = join(tmpRoot, tgz);
    writeFileSync(tmpTgz, await fetchBuf(url, "dsh-install-local"));
    const sumsTxt = (await fetchBuf(RELEASE_BASE + "/SHA256SUMS", "dsh-install-local")).toString("utf8");
    // 安装已校验的本地文件(而非重新从网络拉取 URL, 避免校验/安装不一致 TOCTOU)
    sha256Guard(tmpTgz, parseSums(sumsTxt).get(tgz), tgz, LOG);
    installSpec(`file:${tmpTgz}`, plugin.pkg);
    continue;
  }
  const abs = join(root, "packages", plugin.dir);
  if (!existsSync(abs) || !existsSync(join(abs, "dist")) || readdirSync(join(abs, "dist")).length === 0) {
    console.error(`dist missing for ${plugin.pkg}; run pnpm build first`);
    process.exit(1);
  }
  console.log(`\n${LOG} add ${plugin.pkg} (${abs})`);
  installSpec(abs, plugin.pkg);
}

// 2-4. reconcile 收尾(公共核): stale 清理 / TRUSTED_BUNDLES / patch 清理
reconcileProfile(profileDir, { patchIds, log: LOG });
console.log(`\n${LOG} 完成。请重启 dsh web 会话以加载插件。`);
