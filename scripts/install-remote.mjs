#!/usr/bin/env node
// install-remote: 一键远程安装 DSH 插件(无需 git clone / 本地仓库)。
//
// 从 GitHub Release 拉取插件 tarball + SHA256SUMS,校验通过后装进
// $DSH_HOME/profiles/web(pnpm add -w),并 reconcile dsh.profile.bundles。
// 与 install-local.mjs --release 等价,但不需要仓库副本——所有信息(包名、
// 版本、tarball 资产)都来自 Release 本身。reconcile/下载校验公共核在
// ./install-shared.mjs(与 install-local 共用)。
//
// 用法(由 scripts/install.sh 引导,或直接):
//   node install-remote.mjs                  # 最新 Release(默认)
//   node install-remote.mjs --tag v0.1.0     # 指定 tag
//   node install-remote.mjs --base <URL>     # 直接给下载目录(含 tgz+SHA256SUMS)
//   node install-remote.mjs --only layout-infer,llm-opencode-zen   # 只装部分
//
// 环境变量: DSH_HOME(默认 ~/.dsh)、DSH_PROFILE(默认 web)、
//          DSH_PLUGIN_REPO(默认 3kaiu/dsh-plugins)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadTo, fetchText, parseSums, pnpmAdd, peekTarballManifest, reconcileProfile, resolveProfileDir, sha256Guard, tgzAssetName } from "./install-shared.mjs";

const LOG = "[install-remote]";
const REPO = process.env.DSH_PLUGIN_REPO ?? "3kaiu/dsh-plugins";
const API = `https://api.github.com/repos/${REPO}`;
const DL_BASE = `https://github.com/${REPO}/releases`;

const args = process.argv.slice(2);
const pick = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const TAG = pick("--tag");
const BASE = pick("--base");
const ONLY = (pick("--only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const profileDir = resolveProfileDir();
const UA = "dsh-install-remote";

// 1. 解析来源:latest 走 GitHub API,取资产清单;--tag/--base 直连
let downloadBase, tgzNames;
if (BASE) {
  downloadBase = BASE;
  tgzNames = null; // 需要先拉 SHA256SUMS 才能知道有哪些 tgz
} else {
  const rel = await (async () => {
    const res = await fetch(`${API}/releases/${TAG ? `tags/${TAG}` : "latest"}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${API}`);
    return res.json();
  })();
  downloadBase = `${DL_BASE}/download/${rel.tag_name}`;
  tgzNames = rel.assets.map((a) => a.name).filter((n) => n.endsWith(".tgz"));
  console.log(`${LOG} Release ${rel.tag_name}(${rel.published_at}) 资产:${rel.assets.length} 个`);
}

if (!existsSync(join(profileDir, "package.json"))) {
  console.error(`web profile not found: ${profileDir}`);
  process.exit(1);
}
// 随机后缀临时目录: 防止已知固定路径 dsh-tgz 被本地攻击者预建为符号链接(TOCTOU/任意写)
const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-tgz-"));

// 2. 下载 SHA256SUMS 与全部 tarball,逐文件校验(fail-closed)。
// 信任模型说明:校验和与产物同源,只能发现传输损坏/资产错配,
// 不能防御 Release 本身被篡改——后者需对摘要另行签名或钉死已知摘要。
const sumsTxt = await fetchText(`${downloadBase}/SHA256SUMS`, UA);
const sums = parseSums(sumsTxt);
if (!tgzNames) tgzNames = [...sums.keys()].filter((n) => n.endsWith(".tgz"));
if (ONLY.length > 0) tgzNames = tgzNames.filter((n) => ONLY.some((o) => n.includes(o.replace(/^@[^/]+\//, "")) || n.includes(o)));
const isValidName = (n) => /^[A-Za-z0-9._-]+$/.test(n);
const verified = [];
for (const name of tgzNames) {
  if (!isValidName(name)) {
    console.error(`${LOG} 非法资产名(疑似路径穿越): ${name};中止安装`);
    process.exit(1);
  }
  const url = `${downloadBase}/${name}`;
  const tmp = join(tmpRoot, name);
  await downloadTo(url, tmp, UA);
  sha256Guard(tmp, sums.get(name), name, LOG);
  // 记录本地已校验路径: 安装即装此文件, 而非重新从网络拉取(避免校验/安装不一致 TOCTOU)
  verified.push({ name, local: tmp });
}
// optionalDependencies 补齐(fixpoint, 真源 = 已下载 tarball 自身 manifest):
// 任一插件声明可选依赖(如 ura 对 @ui-restore/core),Release 里有对应资产就
// 连带下载安装 —— --only 装 ura 后运行时 import @ui-restore/core 才不会
// MODULE_NOT_FOUND。缺资产则降级跳过声明者插件(与 install-local --release
// 旧 Release 行为对齐: 硬装也会因运行时 import 失败)。
const skipIdx = new Set();
for (let i = 0; i < verified.length; i++) {
  if (skipIdx.has(i)) continue;
  const optDeps = peekTarballManifest(verified[i].local)?.optionalDependencies ?? {};
  for (const [depName, depSpec] of Object.entries(optDeps)) {
    if (!/^[\w@/.-]+$/.test(depSpec)) continue; // 非 registry 语义(如 workspace:*)不入资产名
    const asset = tgzAssetName({ name: depName, version: depSpec });
    if (verified.some((v) => v.name === asset)) continue;
    if (!sums.has(asset)) {
      console.warn(`${LOG} Release 缺少 ${asset}(旧版 Release?): 跳过 ${verified[i].name} —— 其运行时依赖 ${depName} 无法满足`);
      skipIdx.add(i);
      break;
    }
    const tmp = join(tmpRoot, asset);
    await downloadTo(`${downloadBase}/${asset}`, tmp, UA);
    sha256Guard(tmp, sums.get(asset), asset, LOG);
    verified.push({ name: asset, local: tmp });
  }
}
const installable = verified.filter((_, i) => !skipIdx.has(i));

// 3. 安装(装已校验的本地文件; --ignore-scripts 防 tarball install 脚本执行)。
// 被声明为 optionalDependencies 的包(如 @ui-restore/core, registry 不存在)先行
// 安装: 装进 profile 根后, 运行时 Node 从插件包内向上解析即可见。声明关系以
// tarball manifest 为真源, 与包从初始资产还是 fixpoint 补齐进入无关。
const depFirst = new Set();
for (const v of verified) {
  for (const [depName, depSpec] of Object.entries(peekTarballManifest(v.local)?.optionalDependencies ?? {})) {
    if (!/^[\w@/.-]+$/.test(depSpec)) continue; // 非 registry 语义(如 workspace:*)
    const asset = tgzAssetName({ name: depName, version: depSpec });
    if (verified.some((x) => x.name === asset)) depFirst.add(asset);
  }
}
const first = installable.filter((v) => depFirst.has(v.name));
const rest = installable.filter((v) => !depFirst.has(v.name));
for (const { name, local } of [...first, ...rest]) pnpmAdd(profileDir, `file:${local}`, name, LOG);

// 4. reconcile 收尾(公共核)。patch 候选 id 从已安装依赖(同 reconcile 的可信
//    来源: file:/link:/https:)的 manifest 派生:
//    无 scope 全名 + 去 dsh- 前缀短名(llm-opencode-zen 注册 id 无前缀,其余有)
const patchIds = new Set();
const pkg = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!/^(file:|link:|https?:)/.test(spec)) continue;
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, "node_modules", name, "package.json"), "utf8"));
    const base = manifest.name.replace(/^@[^/]+\//, "");
    patchIds.add(base);
    patchIds.add(base.replace(/^dsh-/, ""));
  } catch { /* manifest 不可读则跳过该候选 */ }
}
reconcileProfile(profileDir, { patchIds: [...patchIds], log: LOG });
