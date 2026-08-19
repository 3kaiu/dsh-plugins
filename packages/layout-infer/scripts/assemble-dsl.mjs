// assemble-dsl.mjs — DSL → stacked-draft.json 算法化组装
// 把第 10-15 轮经验(统计卡烘焙/独立图标/rootSvg 拆解/图片本地化)固化为可复现算法。
//
// 用法:node assemble-dsl.mjs <fixtureDir>
// 输入:fixtureDir/{dsl-full.json, svgs-official.json, <prefix>-sec-{i}.json}
// 输出:fixtureDir/stacked-draft.json
//
// 算法要点(设计意图判定见 15-dsl-render-algorithm.md §7):
//   1. 根 svg(layerId 自身)拆解:卡(宽>100)/图标(≤40)/分隔条(高≤6)分类;
//      多元素旋转角度各异 = 刻意设计(卡 6°/6°/8°,图标独立旋转),必须保留
//   2. 卡烘焙:白底 path + 渐变 path(defs 原样,stop0 透明保留=白底透出)
//      + 内阴影(克隆白底,fill=顶部渐变带,高度 = inset 阴影偏移+扩散,alpha 0.95→0);
//      viewBox = matrix 变换后 bbox(旋转卡不裁切,img 尺寸=bbox,中心自动对齐 DSL 框)
//   3. 图标独立:保留自身旋转 matrix,平移对齐 DSL section 坐标,blur(1.2px)→ css blur 半值
//   4. rootSvg 只留分隔条(卡/图标被拆走,覆盖判定用剩余 bbox)
//   5. 外部图片 URL → assets/ 本地化(离线可显示,manifest.json 记录)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const DIR = process.argv[2] || "/Users/seeu/dev/dsh-opencode-zen/packages/layout-infer/fixtures/mg-gaiban2";
const FULL = path.join(DIR, "dsl-full.json");
const SVGJSON = path.join(DIR, "svgs-official.json");
const OUT = path.join(DIR, "stacked-draft.json");
const ASSETS = path.join(DIR, "assets");

const full = JSON.parse(fs.readFileSync(FULL, "utf8"));
const root = full.nodes[0];
const canvas = { width: root.layoutStyle.width, height: root.layoutStyle.height };
const rootMeta = {};
if (root.fill) rootMeta.background = root.fill;
const layerId = root.id;

// ---------- 工具 ----------
const reNum = /-?\d+\.?\d*(?:[eE][-+]?\d+)?/g;
function matrixArgs(tag) {
  const tr = /<[^>]*\btransform="([^"]+)"/.exec(tag);
  if (!tr) return [1, 0, 0, 1, 0, 0];
  const m = tr[1].match(reNum);
  if (!m) return [1, 0, 0, 1, 0, 0];
  return m.slice(0, 6).map(Number);
}
function transformBB(d, m) {
  const nums = d.match(reNum);
  if (!nums) return [0, 0, 0, 0];
  const xs = [], ys = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = Number(nums[i]), y = Number(nums[i + 1]);
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function mstr(m) { return `matrix(${m.map((v) => (Math.round(v * 10000) / 10000)).join(",")})`; }
const px = (n) => String(Math.round(n * 100) / 100);

// ---------- 1. sections:骨架(root.children)+ 分片 dsl ----------
const secFiles = fs.readdirSync(DIR).filter((f) => /-sec-\d+\.json$/.test(f));
const secById = new Map();
for (const f of secFiles) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  const sid = d.section?.id;
  if (sid) secById.set(sid, d.dsl);
}
const sections = [];
// 递归整树收集:凡 id 有 sec 分片的节点都是 section(含嵌套容器内的),
// 页面坐标 = 父链 relativeX/Y 累加(嵌套 section 的 x/y 相对父容器,非根)
function walkTree(node, accX, accY, depth) {
  for (const c of node.children || []) {
    const ls = c.layoutStyle || {};
    const x = accX + (ls.relativeX ?? 0), y = accY + (ls.relativeY ?? 0);
    if (secById.has(c.id)) {
      // 页面外 section 排除:设计稿画布外残留(如整页 svg 导出坐标系的负坐标内容)不渲染
      if (x < 0 || y < 0) continue;
      sections.push({
        id: c.id, name: c.name, type: c.type,
        x, y,
        width: ls.width ?? 0, height: ls.height ?? 0,
        dsl: secById.get(c.id),
        _depth: depth,
      });
    }
    walkTree(c, x, y, depth + 1);
  }
}
walkTree(root, 0, 0, 0);
sections.sort((a, b) => a.y - b.y || a.x - b.x);

// ---------- 2. 图片 URL 本地化 ----------
fs.mkdirSync(ASSETS, { recursive: true });
const manifestPath = path.join(ASSETS, "manifest.json");
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { /* 首次 */ }
function collectUrls(v, acc) {
  if (typeof v === "string") {
    for (const m of v.matchAll(/https:\/\/image-resource\.mastergo\.com\/[^\s"\\,)]+/g)) acc.add(m[0]);
    return;
  }
  if (Array.isArray(v)) { for (const x of v) collectUrls(x, acc); return; }
  if (v && typeof v === "object") { for (const k of Object.keys(v)) collectUrls(v[k], acc); }
}
function localize(v) {
  if (typeof v === "string") {
    for (const [u, local] of Object.entries(manifest)) v = v.split(u).join(local);
    return v;
  }
  if (Array.isArray(v)) return v.map(localize);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = localize(v[k]); return o; }
  return v;
}
const urls = new Set();
for (const s of sections) if (s.dsl) collectUrls(s.dsl, urls);
let downloaded = 0;
for (const u of urls) {
  if (manifest[u]) continue;
  const ext = u.split("/").pop().includes(".jpg") ? ".jpg" : ".png";
  const name = crypto.createHash("md5").update(u).digest("hex").slice(0, 16) + ext;
  const dest = path.join(ASSETS, name);
  if (!fs.existsSync(dest)) {
    try {
      const data = execFileSync("curl", ["-fsSL", "--max-time", "15", u], { encoding: null });
      fs.writeFileSync(dest, data);
      downloaded++;
    } catch {
      console.warn(`[assemble] 图片下载失败(保留远程 URL): ${u}`);
      continue;
    }
  }
  manifest[u] = `assets/${name}`;
}
if (downloaded) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
for (const s of sections) if (s.dsl) s.dsl = localize(s.dsl);
console.log(`[assemble] sections: ${sections.length} | 图片本地化: ${downloaded} 张新增`);

// ---------- 3. rootSvg 检测与拆解 ----------
const svgData = JSON.parse(fs.readFileSync(SVGJSON, "utf8"));
const rootSvg = (svgData.svgs || []).find((s) => s.id === layerId);
let draft = { canvas, rootMeta, sections };
// 整块切图方案(第 16 轮):rootSvg 是设计稿统计区整块官方导出,
// 直接整块高清位图铺底 + 文本叠加 = 最忠实"切图",不做 path 拆解重建。
// (拆解逻辑保留在历史版本,不再使用)
if (rootSvg) {
  const svg = rootSvg.svg;
  const vb = /viewBox="([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/.exec(svg);
  const [vx, vy, vw, vh] = vb ? vb.slice(1, 5).map(Number) : [0, 0, 0, 0];
  // 整块切图仅当 rootSvg 是"局部区域"(明显小于页面):整页 svg(旧稿 1025x813 > 375x811)
  // 是整页铺底语义,切图会双份渲染 + 覆盖误判
  const cw = draft.canvas?.width || 0, ch = draft.canvas?.height || 0;
  if (vw >= cw * 0.9 && vh >= ch * 0.9) {
    console.log(`[assemble] rootSvg 为整页(${vw}x${vh} vs 页面 ${cw}x${ch}),跳过整块切图`);
  } else {
    draft = { ...draft, rootSvg: { svg, x: vx, y: vy, w: vw, h: vh }, statCards: [], statIcons: [] };
    console.log(`[assemble] rootSvg 整块切图: ${vw}x${vh} @(${vx},${vy})`);
  }
  console.log(`[assemble] rootSvg 整块切图: ${vw}x${vh} @(${vx},${vy})`);
} else {
  console.log("[assemble] 无根 svg(直接渲染 sections)");
}

fs.writeFileSync(OUT, JSON.stringify(draft, null, 1));
console.log(`[assemble] written: ${OUT}`);