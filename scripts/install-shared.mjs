// install-shared — install-local / install-remote 的公共核(2026-08-30 去重)
//
// 两脚本原各自持有逐字相同的 reconcile 尾巴(stale 清理/TRUSTED_BUNDLES/
// bundles reconcile/patch 清理)与下载校验助手, 曾已出现注释漂移。
// 本模块单点维护; 行为契约:
//   - reconcileProfile: 清理无 scope 旧依赖 → 仅 TRUSTED_BUNDLES 可注入
//     dsh.profile.bundles(防任意 dsh-* 包静默 RCE) → cordis.patch.yml
//     移除旧插件条目(bundle 层 patch 取代注册, 每条目连带删 2 行)
//   - 下载助手统一 UA 与错误处理; SHA-256 校验 fail closed
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const TRUSTED_BUNDLES = new Set([
  "@3kaiu/dsh-llm-opencode-zen",
  "@3kaiu/dsh-layout-infer",
  "@3kaiu/dsh-plugin-kit",
]);

// 历史 install.mjs 写入的无 scope 依赖条目(现统一清理)
export const STALE_DEPS = ["dsh-llm-opencode-zen", "dsh-harness-updater", "dsh-layout-infer"];

/** profile 目录解析: DSH_HOME(默认 ~/.dsh) + DSH_PROFILE(默认 web) */
export function resolveProfileDir(env = process.env) {
  const home = env.DSH_HOME?.length > 0 ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "profiles", env.DSH_PROFILE ?? "web");
}

/**
 * pnpm add 进 profile(--ignore-scripts: 插件无需构建, 防 tarball install 脚本执行)。
 * -w 仅在 profile 是 pnpm workspace(dsh CLI 创建的真实 profile 带 pnpm-workspace.yaml)
 * 时合法; 裸目录(全新机器/测试环境)必须省略, 否则报
 * "--workspace-root may only be used inside a workspace"。
 */
export function pnpmAdd(profileDir, spec, label, log = "[install]") {
  console.log(`${log} add ${label} <- ${spec}`);
  const inWorkspace = existsSync(join(profileDir, "pnpm-workspace.yaml"));
  const args = ["add", ...(inWorkspace ? ["-w"] : []), "--ignore-scripts", spec];
  const r = spawnSync("pnpm", args, { cwd: profileDir, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`pnpm add 失败: ${label}`);
}

/**
 * reconcile 收尾(两安装路径共用的完整尾巴):
 * 1) 清理 stale 无 scope 依赖; 2) file:/https: 依赖中声明 dsh.bundle.patch 的,
 *    仅 TRUSTED_BUNDLES 内的注入 dsh.profile.bundles; 3) cordis.patch.yml
 *    按 patchIds(或调用方派生的候选 id)移除旧插件条目。
 */
export function reconcileProfile(profileDir, { patchIds, log = "[install]" }) {
  const pkgFile = join(profileDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));

  const stale = Object.keys(pkg.dependencies ?? {}).filter((name) => STALE_DEPS.includes(name));
  for (const name of stale) delete pkg.dependencies[name];

  const bundles = pkg.dsh?.profile?.bundles ?? [];
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    // file:(本地源码)或 https?:(Release tarball)都算可 reconcile 的 bundle 来源
    if (!/^(file:|https?:)/.test(spec)) continue;
    const local = spec.startsWith("file:");
    // file: 可能是相对路径(pnpm 按 profile 目录解析),统一 resolve 成绝对路径。
    // 注意: file: 指向 Release tarball 时是【文件】而非目录 —— 包已被 pnpm 装进
    // node_modules, 必须回退到那里读 manifest(修复前 tarball 路径恒被跳过,
    // 纯 remote 安装的 bundles 恒为空, 插件从未真正进入 harness)。
    let abs = local ? resolve(spec.slice("file:".length)) : join(profileDir, "node_modules", name);
    if (!existsSync(join(abs, "package.json")) && existsSync(join(profileDir, "node_modules", name, "package.json"))) {
      abs = join(profileDir, "node_modules", name);
    }
    if (!existsSync(join(abs, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
    if (manifest.dsh?.bundle?.patch === void 0) continue;
    if (!TRUSTED_BUNDLES.has(name)) {
      console.warn(`${log} 跳过未授权 bundle(不注入 harness): ${name} — 若为新插件请在 TRUSTED_BUNDLES 显式登记`);
      continue;
    }
    if (!bundles.includes(name)) bundles.push(name);
  }
  pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } };
  if (Object.keys(pkg.dependencies ?? {}).length === 0) delete pkg.dependencies;
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  if (stale.length > 0) console.log(`${log} removed stale deps: ${stale.join(", ")}`);

  // cordis.patch.yml: bundle 层 patch 取代插件注册, 命中条目连带其后续 2 行一并移除
  const patchFile = join(profileDir, "cordis.patch.yml");
  const patchText = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
  if (patchText.trim() !== "") {
    const lines = patchText.split("\n");
    const out = [];
    let skip = 0;
    for (const line of lines) {
      if (skip > 0) { skip -= 1; continue; }
      if (patchIds.some((id) => line.includes(id))) { skip = 2; continue; }
      out.push(line);
    }
    writeFileSync(patchFile, out.join("\n"));
    console.log(`${log} cordis.patch.yml 已清理旧插件条目`);
  }
}

/** 解析 SHA256SUMS 文本 → Map(文件名 → 摘要); 容忍二进制标记(*)与多空格 */
export function parseSums(text) {
  return new Map(text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [sum, ...rest] = l.split(/\s+/);
    return [rest.join(" ").replace(/^\*/, ""), sum];
  }));
}

/** 单文件 SHA-256 校验(fail closed): 摘要不匹配或无条目即中止进程 */
export function sha256Guard(filePath, want, name, log = "[install]") {
  const got = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (!want || want !== got) {
    console.error(`${log} SHA-256 校验失败: ${name}(期望 ${want ?? "无条目"},实得 ${got});中止安装——请确认 Release 已重建(含 SHA256SUMS 资产)`);
    process.exit(1);
  }
  console.log(`${log} SHA-256 校验通过: ${name} ${got.slice(0, 12)}…`);
}

export async function fetchBuf(url, ua = "dsh-plugins-installer") {
  const res = await fetch(url, { headers: { "User-Agent": ua } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchText(url, ua = "dsh-plugins-installer") {
  const res = await fetch(url, { headers: { "User-Agent": ua } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

export async function downloadTo(url, dest, ua = "dsh-plugins-installer") {
  writeFileSync(dest, await fetchBuf(url, ua));
}
