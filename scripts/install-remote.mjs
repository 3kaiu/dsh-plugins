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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadTo, fetchText, parseSums, pnpmAdd, reconcileProfile, resolveProfileDir, sha256Guard } from "./install-shared.mjs";

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
if (ONLY.length > 0) {
  tgzNames = tgzNames.filter((n) => ONLY.some((o) => n.includes(o.replace(/^@[^/]+\//, "")) || n.includes(o)));
}
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

// 3. 安装(装已校验的本地文件; --ignore-scripts 防 tarball install 脚本执行)
for (const { name, local } of verified) pnpmAdd(profileDir, `file:${local}`, name, LOG);

// 4. reconcile 收尾(公共核)。patch 候选 id 从已安装 https: 依赖的 manifest 派生:
//    无 scope 全名 + 去 dsh- 前缀短名(llm-opencode-zen 注册 id 无前缀,其余有)
const patchIds = new Set();
const pkg = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!/^https?:/.test(spec)) continue;
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, "node_modules", name, "package.json"), "utf8"));
    const base = manifest.name.replace(/^@[^/]+\//, "");
    patchIds.add(base);
    patchIds.add(base.replace(/^dsh-/, ""));
  } catch { /* manifest 不可读则跳过该候选 */ }
}
reconcileProfile(profileDir, { patchIds: [...patchIds], log: LOG });
