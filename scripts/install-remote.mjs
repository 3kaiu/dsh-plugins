#!/usr/bin/env node
// install-remote: 一键远程安装 DSH 插件(无需 git clone / 本地仓库)。
//
// 从 GitHub Release 拉取插件 tarball + SHA256SUMS,校验通过后装进
// $DSH_HOME/profiles/web(pnpm add -w),并 reconcile dsh.profile.bundles。
// 与 install-local.mjs --release 等价,但不需要仓库副本——所有信息(包名、
// 版本、tarball 资产)都来自 Release 本身。
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.DSH_PLUGIN_REPO ?? "3kaiu/dsh-plugins";
const API = `https://api.github.com/repos/${REPO}`;
const DL_BASE = `https://github.com/${REPO}/releases`;

const args = process.argv.slice(2);
const pick = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const TAG = pick("--tag");
const BASE = pick("--base");
const ONLY = (pick("--only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const profileDir = join(process.env.DSH_HOME?.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh"), "profiles", process.env.DSH_PROFILE ?? "web");
const patchFile = join(profileDir, "cordis.patch.yml");

const jsonFetch = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "dsh-install-remote" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
};

const pnpmAdd = (spec, label) => {
  console.log(`[install-remote] add ${label} <- ${spec}`);
  const r = spawnSync("pnpm", ["add", "-w", spec], { cwd: profileDir, stdio: "inherit" });
  if(r.status!==0) throw new Error(`pnpm add 失败: ${label}`);
};

// 1. 解析来源:latest 走 GitHub API,取资产清单;--tag/--base 直连
let downloadBase, tgzNames;
if (BASE) {
  downloadBase = BASE;
  tgzNames = null; // 需要先拉 SHA256SUMS 才能知道有哪些 tgz
} else {
  const rel = await jsonFetch(`${API}/releases/${TAG ? `tags/${TAG}` : "latest"}`);
  downloadBase = `${DL_BASE}/download/${rel.tag_name}`;
  tgzNames = rel.assets.map((a) => a.name).filter((n) => n.endsWith(".tgz"));
  console.log(`[install-remote] Release ${rel.tag_name}(${rel.published_at}) 资产:${rel.assets.length} 个`);
}

if (!existsSync(join(profileDir, "package.json"))) {
  console.error(`web profile not found: ${profileDir}`);
  process.exit(1);
}
mkdirSync(join(tmpdir(), "dsh-tgz"), { recursive: true });

// 2. 下载 SHA256SUMS 与全部 tarball,逐文件校验(fail-closed)。
// 信任模型说明:校验和与产物同源,只能发现传输损坏/资产错配,
// 不能防御 Release 本身被篡改——后者需对摘要另行签名或钉死已知摘要。
const fetchText = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "dsh-install-remote" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
};
const downloadTo = async (url, dest) => {
  const res = await fetch(url, { headers: { "User-Agent": "dsh-install-remote" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
};
const sumsTxt = await fetchText(`${downloadBase}/SHA256SUMS`);
const sums = new Map(sumsTxt.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
  const [sum, ...rest] = l.split(/\s+/);
  return [rest.join(" ").replace(/^\*/, ""), sum];
}));
if (!tgzNames) tgzNames = [...sums.keys()].filter((n) => n.endsWith(".tgz"));
if (ONLY.length > 0) {
  tgzNames = tgzNames.filter((n) => ONLY.some((o) => n.includes(o.replace(/^@[^/]+\//, "")) || n.includes(o)));
}
const verified = [];
for (const name of tgzNames) {
  const url = `${downloadBase}/${name}`;
  const tmp = join(tmpdir(), "dsh-tgz", name);
  await downloadTo(url, tmp);
  const want = sums.get(name);
  const got = createHash("sha256").update(readFileSync(tmp)).digest("hex");
  if (!want || want !== got) {
    console.error(`[install-remote] SHA-256 校验失败: ${name}(期望 ${want ?? "无条目"},实得 ${got});中止安装`);
    process.exit(1);
  }
  console.log(`[install-remote] SHA-256 校验通过: ${name} ${got.slice(0, 12)}…`);
  verified.push({ name, url });
}

// 3. 安装(URL spec 持久化;本地已校验,与 install-local --release 同一信任模型)
for (const { name, url } of verified) pnpmAdd(url, name);

// 4. reconcile bundles + 清理旧 patch 条目(逻辑与 install-local 一致)
const pkgFile = join(profileDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
const stale = Object.keys(pkg.dependencies ?? {}).filter((name) =>
  ["dsh-llm-opencode-zen", "dsh-harness-updater", "dsh-layout-infer"].includes(name));
for (const name of stale) delete pkg.dependencies[name];
const bundles = pkg.dsh?.profile?.bundles ?? [];
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!/^https?:/.test(spec)) continue;
  const abs = join(profileDir, "node_modules", name);
  if (!existsSync(join(abs, "package.json"))) continue;
  const manifest = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
  if (manifest.dsh?.bundle?.patch === void 0) continue;
  if (!bundles.includes(name)) bundles.push(name);
}
pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } };
if (Object.keys(pkg.dependencies ?? {}).length === 0) delete pkg.dependencies;
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
if (stale.length > 0) console.log(`[install-remote] removed stale deps: ${stale.join(", ")}`);

const patchText = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
if (patchText.trim() !== "") {
  // 每包派生候选 patch id:从已安装 manifest 取无 scope 全名 + 去 dsh- 前缀的短名
  // (llm-opencode-zen 注册 id 无 dsh- 前缀,其余有,两种都匹配)
  const ids = new Set();
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (!/^https?:/.test(spec)) continue;
    const manifest = JSON.parse(readFileSync(join(profileDir, "node_modules", name, "package.json"), "utf8"));
    const base = manifest.name.replace(/^@[^/]+\//, "");
    ids.add(base);
    ids.add(base.replace(/^dsh-/, ""));
  }
  const lines = patchText.split("\n");
  const out = [];
  let skip = 0;
  for (const line of lines) {
    if (skip > 0) { skip -= 1; continue; }
    if ([...ids].some((id) => line.includes(id))) { skip = 2; continue; }
    out.push(line);
  }
  writeFileSync(patchFile, out.join("\n"));
  console.log("[install-remote] cordis.patch.yml 已清理旧插件条目");
}
console.log("\n[install-remote] 完成。请重启 dsh web 会话以加载插件。");