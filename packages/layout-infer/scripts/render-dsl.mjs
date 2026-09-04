// render-dsl.mjs — DSL → 技术中立还原描述树(tree.json)
// ============================================================
// 本文件是"还原决策引擎":输入 stacked-draft.json(+dsl-full.json 文本补全),
// 输出 tech-neutral 描述树。描述树不含任何 HTML/CSS/DOM 语法:
//   - 布局:绝对定位(x/y/width/height)与 flex 语义(direction/gap/align/justify/padding)
//   - 样式:设计值(color/gradient/radius/shadows/blur/opacity/rotate/stroke/font)
//   - 内容:文本值、svg 矢量数据、图片引用、位图化标记(bitmap)
// 任意技术栈(Vue/React/RN/Flutter/小程序/原生)都能消费同一棵树实现同等还原。
// HTML 输出由 adapter-html.mjs 完成(仅 web 适配器之一)。
//
// 用法:node render-dsl.mjs [fixtureDir] → tree.json
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { simulateFlex } from "../../shared/dist/index.js";

const DIR = process.argv[2] || fileURLToPath(new URL("../fixtures/mg-demo-2025", import.meta.url));
const DRAFT = `${DIR}/stacked-draft.json`;
const FULL = `${DIR}/dsl-full.json`;
const OUT = `${DIR}/tree.json`;

const draft = JSON.parse(fs.readFileSync(DRAFT, "utf8"));
const fullDsl = JSON.parse(fs.readFileSync(FULL, "utf8"));
const canvas = draft.canvas;
const stat = { flexContainers: 0, flexPassed: 0, flexFallback: 0, officialSvg: 0, pathFallback: 0, tokenResolved: 0, texts: 0, droppedSections: 0, missingFill: 0, chromeSkipped: 0, svgAligned: 0, rasterized: 0, componentized: 0, rootSvgCovered: 0 };
let globalTplIdx = 0;
const SVGJSON = `${DIR}/svgs-official.json`;
const officialSvgs = new Map();
try {
  const svgData = JSON.parse(fs.readFileSync(SVGJSON, "utf8"));
  for (const s of svgData.svgs || []) officialSvgs.set(s.id, s.svg);
} catch { /* 无官方 SVG 时回退 path 拼装 */ }

// ---------- 基础 ----------
function isChromeLayer(root) {
  let hit = false;
  (function walk(n) {
    if (hit) return;
    const t = (n.text || []).map((x) => x.text || "").join("").trim();
    if (/^\d{1,2}:\d{2}$/.test(t)) { hit = true; return; }
    if (/Battery|信号|状态栏|StatusBar|Indicator/i.test(n.name || "")) { hit = true; return; }
    (n.children || []).forEach(walk);
  })(root);
  return hit;
}
function hasContent(n) {
  if (n.type === "TEXT" || n.type === "LAYER") return true;
  return (n.children || []).some(hasContent);
}
function svgContentFingerprint(svg) {
  return svgPathBBoxes(svg).map((b) => b.map((v) => Math.round(v * 2) / 2).join(",")).join(";");
}
function contentFingerprint(n) {
  if (n.type === "TEXT") return "T:" + (n.text || []).map((x) => x.text || "").join("");
  if (n.type === "PATH") return "P";
  if (n.type === "LAYER") {
    const u = n.fill && typeof n.fill === "object" ? n.fill.url : "";
    return "L:" + (u || "");
  }
  const ls = n.layoutStyle || {};
  const size = (Math.round((ls.width || 0) / 2) * 2) + "x" + (Math.round((ls.height || 0) / 2) * 2);
  const official = officialSvgs.get(n.id);
  if (official && !hasContent(n)) return "S:" + size + ":" + svgContentFingerprint(official);
  const kids = (n.children || []).map(contentFingerprint).join(",");
  if (!kids && !hasContent(n)) return "E:" + size;
  return n.type + ":" + size + "[" + kids + "]";
}
function dbbox(d) {
  const nums = [...d.matchAll(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g)].map(Number);
  if (nums.length < 4) return null;
  const xs = [], ys = [];
  for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function svgPathBBoxes(svg) {
  const out = [];
  for (const m of svg.matchAll(/<path\b[^>]*?\/?>/g)) {
    const dm = m[0].match(/\bd="([^"]+)"/);
    if (!dm) continue;
    let bb = dbbox(dm[1]);
    const tm = m[0].match(/transform="matrix\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)"/);
    if (bb && tm) bb = matrixTransformBB(bb, tm.slice(1, 7).map(Number));
    if (bb) out.push(bb);
  }
  return out;
}
function matrixTransformBB(bb, m) {
  const [a, b, c, d, e, f] = m;
  const xs = [], ys = [];
  for (const [x, y] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]]) {
    xs.push(a * x + c * y + e);
    ys.push(b * x + d * y + f);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
// svg 装饰内容居中(带贴边豁免)
function centerSvgDecor(svg) {
  const vbm = svg.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/);
  if (!vbm) return svg;
  const [vx, vy, vw, vh] = vbm.slice(1).map(Number);
  const tags = [...svg.matchAll(/<path\b[^>]*?\/?>/g)].map((m) => m[0]);
  if (!tags.length) return svg;
  const withIdx = [];
  tags.forEach((t, i) => {
    const d = t.match(/\bd="([^"]+)"/);
    if (!d) return;
    let bb = dbbox(d[1]);
    const tm = t.match(/transform="matrix\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)"/);
    if (bb && tm) bb = matrixTransformBB(bb, tm.slice(1, 7).map(Number));
    withIdx.push({ i, bb });
  });
  if (!withIdx.length) return svg;
  const cover = (b) => {
    const ix = Math.max(0, Math.min(b[2], vx + vw) - Math.max(b[0], vx));
    const iy = Math.max(0, Math.min(b[3], vy + vh) - Math.max(b[1], vy));
    return (ix * iy) / (vw * vh);
  };
  const decorIdx = withIdx.filter((x) => cover(x.bb) < 0.9).map((x) => x.i);
  const bbs = withIdx.map((x) => x.bb);
  if (!decorIdx.length) return svg;
  const xs = [], ys = [];
  for (const i of decorIdx) { xs.push(bbs[i][0], bbs[i][2]); ys.push(bbs[i][1], bbs[i][3]); }
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const vcx = vx + vw / 2, vcy = vy + vh / 2;
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  if (Math.max(Math.abs(cx - vcx), Math.abs(cy - vcy)) <= 2) return svg;
  if (bw >= vw * 0.85 || bh >= vh * 0.85) return svg;
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  const edgeGap = Math.min(minX - vx, minY - vy, vx + vw - maxX, vy + vh - maxY);
  if (edgeGap < 2) return svg;
  const dx = vcx - cx, dy = vcy - cy;
  const head = svg.slice(0, svg.indexOf("<path"));
  const tail = svg.slice(svg.lastIndexOf("</svg>"));
  let idx = 0, rebuilt = "";
  for (const t of tags) {
    rebuilt += decorIdx.includes(idx) ? `<g transform="translate(${dx},${dy})">${t}</g>` : t;
    idx++;
  }
  return head + rebuilt + tail;
}
// svg 铺底:背景 PATH children 的 inset effect(统计卡内阴影)→ 结构化 shadows
function backdropShadows(node, styles) {
  const bgPath = (node.children || []).find((k) => k.type === "PATH" && k.effect && !officialSvgs.has(k.id));
  return bgPath ? effectStructured(styles, bgPath.effect).shadows : [];
}
// 整卡合成:背景 svg + 图标 cluster + inset 内阴影 → 一张位图(svg 矢量数据,中立)
function composeCardSvg(node, styles, ex) {
  const bgSvg = ex.bgSvg;
  const head = (bgSvg.match(/<svg[^>]*>/) || [""])[0];
  if (!head) return bgSvg;
  const inner = bgSvg.slice(head.length, bgSvg.lastIndexOf("</svg>"));
  let blurPx = null, insetColor = null;
  for (const k of node.children || []) {
    if (k.type !== "PATH" || !k.effect || officialSvgs.has(k.id)) continue;
    const eff = effectStructured(styles, k.effect);
    if (eff.blur != null) blurPx = eff.blur;
    const sh = eff.shadows.join(" ");
    if (sh.includes("inset")) {
      const cm = sh.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/);
      if (cm) insetColor = cm[1];
    }
  }
  const nid = String(node.id || "card").replace(/[^a-zA-Z0-9]/g, "_");
  let defsExtra = "", extra = "";
  if (insetColor) {
    const dm = inner.match(/<path\b[^>]*\bd="([^"]+)"/);
    const vb = head.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/);
    const vbH = vb ? parseFloat(vb[4]) : 100;
    const pm = inner.match(/<path\b[^>]*>/);
    if (pm && vb) {
      const y2 = Math.min(0.5, 20 / vbH).toFixed(3);
      defsExtra += `<linearGradient id="${nid}_inset" x1="0" y1="0" x2="0" y2="${y2}"><stop offset="0" stop-color="${insetColor}" stop-opacity="0.9"/><stop offset="1" stop-color="${insetColor}" stop-opacity="0"/></linearGradient>`;
      extra += pm[0].replace(/fill="[^"]*"/, `fill="url(#${nid}_inset)"`);
    }
  }
  for (const c of ex.clusters) {
    const cHead = (c.svg.match(/<svg[^>]*>/) || [""])[0];
    if (!cHead) continue;
    const cInner = c.svg.slice(cHead.length, c.svg.lastIndexOf("</svg>"));
    let g = cInner;
    if (c.dx || c.dy) g = `<g transform="translate(${c.dx || 0},${c.dy || 0})">${g}</g>`;
    if (blurPx != null) {
      defsExtra += `<filter id="${nid}_ib" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blurPx / 2}"/></filter>`;
      g = `<g filter="url(#${nid}_ib)">${g}</g>`;
    }
    extra += g;
  }
  return head + (defsExtra ? `<defs>${defsExtra}</defs>` : "") + inner + extra + "</svg>";
}
function wildcardMatch(wfp, fp) {
  if (wfp === fp) return true;
  const re = new RegExp("^" + wfp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\\\*/g, ":.*") + "$");
  return re.test(fp);
}
function shiftPathD(d, dx, dy) {
  let i = 0;
  return d.replace(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g, (m) => {
    const v = parseFloat(m);
    return String(i++ % 2 === 0 ? v + dx : v + dy);
  });
}
function shiftOutOfBoundsPaths(svg, vb) {
  const vbX = +vb[1], vbY = +vb[2], vbW = +vb[3], vbH = +vb[4];
  const pathes = [...svg.matchAll(/<path\b[^>]*?\/?>/g)];
  const info = pathes.map((m) => {
    const raw = m[0];
    const dm = raw.match(/\bd="([^"]+)"/);
    const tm = raw.match(/transform="matrix\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)"/);
    let bb = dm ? dbbox(dm[1]) : null;
    const mat = tm ? tm.slice(1, 7).map(Number) : null;
    if (bb && mat) bb = matrixTransformBB(bb, mat);
    return { raw, d: dm && dm[1], bb, mat, hasT: !!tm };
  });
  const oob = (it) => {
    if (!it.bb) return false;
    const ix = Math.min(it.bb[2], vbX + vbW) - Math.max(it.bb[0], vbX);
    const iy = Math.min(it.bb[3], vbY + vbH) - Math.max(it.bb[1], vbY);
    const inter = ix > 0 && iy > 0 ? ix * iy : 0;
    const area = (it.bb[2] - it.bb[0]) * (it.bb[3] - it.bb[1]);
    return inter < area * 0.4;
  };
  let dx = null, dy = null;
  for (const it of info) {
    if (oob(it)) { dx = vbX - it.bb[0]; dy = vbY - it.bb[1]; break; }
  }
  if (dx === null) return svg;
  let out = svg;
  for (const it of info) {
    if (!oob(it)) continue;
    if (it.hasT) {
      const m = it.mat;
      const ne = String(Math.round((m[4] + dx) * 100) / 100), nf = String(Math.round((m[5] + dy) * 100) / 100);
      out = out.replace(it.raw, it.raw.replace(/transform="matrix\([^"]+\)"/, `transform="matrix(${m[0]},${m[1]},${m[2]},${m[3]},${ne},${nf})"`));
    } else {
      out = out.split(it.d).join(shiftPathD(it.d, dx, dy));
    }
  }
  return out;
}
// svg 内小 path cluster → 独立图标
function extractIconClusters(svg) {
  const head = svg.match(/<svg[^>]*>/);
  const vb = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/);
  if (!head || !vb) return { bgSvg: svg, clusters: [] };
  const vbW = +vb[3], vbH = +vb[4];
  const pathes = [...svg.matchAll(/<path\b[^>]*?\/?>/g)];
  const small = [];
  for (const m of pathes) {
    const dm = m[0].match(/\bd="([^"]+)"/);
    if (!dm) continue;
    const tm = m[0].match(/transform="translate\(([-\d.]+),([-\d.]+)\)"/);
    const bb0 = dbbox(dm[1]);
    if (!bb0) continue;
    if ((bb0[2] - bb0[0]) * (bb0[3] - bb0[1]) >= vbW * vbH * 0.4) continue;
    const sx = tm ? +tm[1] : 0, sy = tm ? +tm[2] : 0;
    let raw = m[0];
    if (tm) raw = raw.replace(/ transform="translate\([^"]*\)"/, "");
    small.push({ raw, bb: [bb0[0] + sx, bb0[1] + sy, bb0[2] + sx, bb0[3] + sy] });
  }
  if (!small.length) return { bgSvg: svg, clusters: [] };
  const u = [Math.min(...small.map((x) => x.bb[0])), Math.min(...small.map((x) => x.bb[1])), Math.max(...small.map((x) => x.bb[2])), Math.max(...small.map((x) => x.bb[3]))];
  const w = u[2] - u[0], h = u[3] - u[1];
  const clusterSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${u[0]} ${u[1]} ${w} ${h}" width="${w}" height="${h}">${small.map((x) => x.raw).join("")}</svg>`;
  let bgSvg = svg;
  for (const x of small) bgSvg = bgSvg.replace(x.raw, "");
  bgSvg = shiftOutOfBoundsPaths(bgSvg, vb);
  return { bgSvg, clusters: [{ x: u[0], y: u[1], w, h, svg: clusterSvg }] };
}
function coverRatio(pb, kb) {
  const ix = Math.min(pb[2], kb[2]) - Math.max(pb[0], kb[0]);
  const iy = Math.min(pb[3], kb[3]) - Math.max(pb[1], kb[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const kbArea = Math.max((kb[2] - kb[0]) * (kb[3] - kb[1]), 1);
  return (ix * iy) / kbArea;
}
// 整体替换 svg 的小图形按 DSL 子节点位置对齐
function alignSvgToChildren(svg, node) {
  const vbm = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/);
  if (!vbm) return svg;
  const vbX = +vbm[1], vbY = +vbm[2], vbW = +vbm[3], vbH = +vbm[4];
  const subs = (node.children || []).filter((k) => (k.type === "GROUP" || k.type === "FRAME") && k.layoutStyle && k.layoutStyle.width && k.layoutStyle.height && (k.layoutStyle.width * k.layoutStyle.height) < vbW * vbH * 0.8);
  if (!subs.length) return svg;
  const bbs = svgPathBBoxes(svg);
  const small = bbs.filter((bb) => (bb[2] - bb[0]) * (bb[3] - bb[1]) < vbW * vbH * 0.4);
  if (!small.length) return svg;
  const su = [Math.min(...small.map((b) => b[0])), Math.min(...small.map((b) => b[1])), Math.max(...small.map((b) => b[2])), Math.max(...small.map((b) => b[3]))];
  if (su[0] - vbX > 6 || su[1] - vbY > 6) return svg;
  let best = null, bestScore = Infinity;
  for (const k of subs) {
    const kl = k.layoutStyle;
    const kb = [kl.relativeX ?? 0, kl.relativeY ?? 0, (kl.relativeX ?? 0) + kl.width, (kl.relativeY ?? 0) + kl.height];
    const sw = su[2] - su[0], sh = su[3] - su[1];
    const sizeScore = Math.abs(kb[2] - kb[0] - sw) / Math.max(sw, 1) + Math.abs(kb[3] - kb[1] - sh) / Math.max(sh, 1);
    if (sizeScore > 1.2) continue;
    const score = sizeScore * 10 + Math.abs((kb[0] + kb[2]) / 2 - (su[0] + su[2]) / 2) + Math.abs((kb[1] + kb[3]) / 2 - (su[1] + su[3]) / 2);
    if (score < bestScore) { bestScore = score; best = { kb, k }; }
  }
  if (!best) return svg;
  const dx = best.kb[0] - su[0], dy = best.kb[1] - su[1];
  if (Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) return svg;
  if (best.kb[0] < -1 || best.kb[1] < -1 || best.kb[2] > vbW + 1 || best.kb[3] > vbH + 1) return svg;
  let n = 0;
  svg = svg.replace(/(<path\b[^>]*?)\bd="([^"]+)"/g, (m, pre, d) => {
    const bb = dbbox(d);
    if (bb && (bb[2] - bb[0]) * (bb[3] - bb[1]) < vbW * vbH * 0.4 && !/transform=/.test(pre)) {
      n++;
      return `${pre} transform="translate(${dx.toFixed(2)},${dy.toFixed(2)})" d="${d}"`;
    }
    return m;
  });
  if (n) stat.svgAligned++;
  return svg;
}
// 官方 svg 获取:defs id 唯一化 + 尺寸覆盖
function officialSvgFor(node) {
  let svg = officialSvgs.get(node.id);
  if (!svg) return null;
  svg = svg.replace(/^<\?xml[^?]*\?>\s*/i, "");
  const uniq = node.id.replace(/[^A-Za-z0-9]/g, "_");
  svg = svg.replace(/id="([^"]+)"/g, (m, id) => `id="${uniq}_${id}"`);
  svg = svg.replace(/url\(#([^)]+)\)/g, (m, id) => `url(#${uniq}_${id})`);
  const ls = node.layoutStyle || {};
  if (ls.width != null) svg = svg.replace(/width="[^"]*"/, `width="${ls.width}"`);
  if (ls.height != null) svg = svg.replace(/height="[^"]*"/, `height="${ls.height}"`);
  return svg;
}

// id → 节点 全量索引(token 文本补全)
const byId = new Map();
(function index(n) { byId.set(n.id, n); (n.children || []).forEach(index); })(fullDsl.nodes[0]);

// ---------- 样式解析(结构化,中立) ----------
function paint(styles, key) {
  if (!key) return null;
  const v = styles[key]?.value;
  if (!v) return null;
  const first = v[0];
  if (typeof first === "string") return first;
  if (first && first.url) return `url(${first.url})`;
  return null;
}
// font → {family,size,weight,lineHeight,letterSpacing,decoration,case}
function fontValue(styles, key) {
  const f = styles[key]?.value;
  if (!f) return null;
  const out = {};
  if (f.family) out.family = f.family.replace(/"/g, "");
  if (f.size) out.size = f.size;
  if (f.weight) out.weight = f.weight;
  if (f.lineHeight && f.lineHeight !== "auto" && f.lineHeight !== "-1") {
    const lh = parseFloat(f.lineHeight);
    if (!isNaN(lh)) out.lineHeight = lh; // >=100 为百分比,<100 为绝对 px(适配器处理)
  }
  if (f.letterSpacing && f.letterSpacing !== "auto") out.letterSpacing = f.letterSpacing;
  if (f.decoration && f.decoration !== "none") out.decoration = f.decoration;
  if (f.case && f.case !== "none") out.case = f.case;
  return out;
}
// effect → {shadows:[{inset,x,y,blur,spread,color}], blur:number|null}
function effectStructured(styles, key) {
  const out = { shadows: [], blur: null };
  if (!key) return out;
  const v = styles[key]?.value;
  if (!v) return out;
  for (const s of v) {
    if (typeof s !== "string") continue;
    if (s.startsWith("box-shadow:")) {
      const sh = s.replace(/^box-shadow:\s*/, "").replace(/;$/, "");
      for (const one of sh.split(",")) {
        const p = parseShadow(one.trim());
        if (p) out.shadows.push(p);
      }
    } else if (s.startsWith("filter:")) {
      const fm = s.match(/blur\(([\d.]+)px\)/);
      if (fm) out.blur = parseFloat(fm[1]);
    }
  }
  return out;
}
// "inset 0px 7.2px 16.8px 0px #FAE8E8" → {inset,x,y,blur,spread,color}
function parseShadow(s) {
  const inset = s.includes("inset");
  const nums = [...s.matchAll(/-?\d*\.?\d+(?:px)?/g)].map((m) => parseFloat(m[0]));
  const cm = s.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/);
  if (!cm || !nums.length) return null;
  const [x, y, blur, spread] = [nums[0] || 0, nums[1] || 0, nums[2] || 0, nums[3] || 0];
  return { inset, x, y, blur, spread, color: cm[1] };
}
// stroke → inset shadows 结构化
function strokeShadows(node, styles) {
  if (!node.strokeColor || !node.strokeWidth) return [];
  const color = paint(styles, node.strokeColor) || node.strokeColor;
  if (!color) return [];
  const vals = String(node.strokeWidth).split(/\s+/).map((v) => parseFloat(v) || 0);
  if (vals.length === 1 && vals[0] > 0) return [{ inset: true, x: 0, y: 0, blur: 0, spread: vals[0], color }];
  const spec = [[0, 1], [-1, 0], [0, -1], [1, 0]];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const v = vals.length === 2 ? vals[i % 2] : vals.length === 3 ? (i === 3 ? vals[1] : vals[i]) : vals[i] ?? 0;
    if (v > 0) out.push({ inset: true, x: spec[i][0], y: spec[i][1], blur: 0, spread: 0, color });
  }
  return out;
}
// borderRadius → number | number[] | null
function radiusValue(node) {
  const br = node.borderRadius;
  if (br == null || br === "") return null;
  if (typeof br === "string") {
    const parts = br.trim().split(/\s+/).map((v) => parseFloat(v));
    return parts.length === 1 ? parts[0] : parts;
  }
  if (Array.isArray(br)) {
    const parts = br.map((v) => parseFloat(v) || 0);
    return parts.length === 1 ? parts[0] : parts;
  }
  return parseFloat(br) || null;
}

// ---------- flex 归一化与回写验证 ----------
function parsePadding(p) {
  if (Array.isArray(p)) return p.map((v) => +v || 0);
  if (typeof p === "string") {
    const parts = p.trim().split(/\s+/).map((v) => parseFloat(v) || 0);
    if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
    if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
    if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
    if (parts.length === 4) return parts;
  }
  return [0, 0, 0, 0];
}
function normalizeFlex(fi) {
  if (!fi || (fi.flexDirection !== "row" && fi.flexDirection !== "column")) return null;
  const gap = (() => {
    if (typeof fi.gap === "number") return fi.gap;
    if (typeof fi.gap === "string") { const g = parseFloat(fi.gap) || 0; return g; }
    if (fi.gap && typeof fi.gap === "object") { const g = fi.gap.row ?? fi.gap.column ?? 0; return +g || 0; }
    return 0;
  })();
  return {
    flexDirection: fi.flexDirection,
    justifyContent: fi.justifyContent,
    alignItems: fi.alignItems,
    gap,
    padding: parsePadding(fi.padding),
  };
}
function decideLayout(containerSize, fi, kids) {
  const lay = normalizeFlex(fi);
  if (!lay) return { mode: "absolute", lay: null, kids };
  const dir = lay.flexDirection;
  const sorted = [...kids].sort((a, b) => {
    const ax = a.layoutStyle?.relativeX ?? 0, ay = a.layoutStyle?.relativeY ?? 0;
    const bx = b.layoutStyle?.relativeX ?? 0, by = b.layoutStyle?.relativeY ?? 0;
    return dir === "row" ? ax - bx : ay - by;
  });
  const rects = sorted.map((k) => {
    const ls = k.layoutStyle || {};
    return { id: k.id, x: ls.relativeX ?? 0, y: ls.relativeY ?? 0, width: ls.width ?? 0, height: ls.height ?? 0 };
  });
  let calc;
  try { calc = simulateFlex(containerSize, lay, rects); } catch { return { mode: "absolute", lay, kids: sorted }; }
  const TOL = 2;
  for (let i = 0; i < sorted.length; i++) {
    const r = rects[i], c = calc[i];
    if (!c) return { mode: "absolute", lay, kids: sorted };
    if (Math.abs(c.x - r.x) > TOL || Math.abs(c.y - r.y) > TOL) return { mode: "absolute", lay, kids: sorted };
  }
  return { mode: "flex", lay, kids: sorted };
}

// ---------- 节点渲染(→ 中立描述节点) ----------
// 节点契约(所有字段可选,省略=默认):
//   kind: "container"|"text"|"shape"|"icon"|"image"|"component"
//   x,y,width,height: 数值(相对父容器)
//   container: flex{direction,justify,align,gap,padding:[t,r,b,l]} | bg(color|gradient|url) |
//              radius(number|array) | shadows[] | blur | opacity | rotate | children
//   text: text | font{family,size,weight,lineHeight,letterSpacing,decoration,case} | color |
//         gradient | stroke{width,color} | shadows[] | blur | align | nowrap | pre | highlights[{start,end,color}]
//   shape: bg | radius | shadows[] | blur | opacity | rotate | stroke
//   icon:  svg | bitmap(true 建议位图化)
//   image: svg | url | fill("parent" 铺满父容器) | bitmap
//   component: template(节点) | instances[{x,y}]
function renderNode(node, styles) {
  const ls = node.layoutStyle || {};
  const w = ls.width, h = ls.height;
  const isContainer = Array.isArray(node.children) && node.children.length > 0;

  const st = {}; // 结构化样式
  let bg = node._color ? node._color : paint(styles, node.fill);
  if (!bg && node.type === "PATH") {
    for (const p of node.path || []) {
      const fl = p.fill;
      if (!fl || String(fl).startsWith("url(#")) continue;
      bg = typeof fl === "string" && !fl.startsWith("paint_") ? fl : paint(styles, fl);
      if (bg) break;
    }
  }
  if (bg) st.bg = bg;
  const rc = radiusValue(node);
  if (rc != null) st.radius = rc;
  const eff = effectStructured(styles, node.effect);
  const shadows = [...eff.shadows, ...strokeShadows(node, styles)];
  if (shadows.length) st.shadows = shadows;
  if (eff.blur != null) st.blur = eff.blur;
  if (node.opacity != null) st.opacity = node.opacity;
  if (ls.rotate && Math.abs(ls.rotate) > 0.5) st.rotate = Math.round(ls.rotate * 10) / 10;

  const official0 = officialSvgFor(node);
  const official = official0 && isContainer ? alignSvgToChildren(official0, node) : official0;
  const svgPartial = official && isContainer && (function hasExtra(n) {
    if (n.type === "TEXT" || n.type === "LAYER") return true;
    return (n.children || []).some(hasExtra);
  })(node);
  if (official) stat.officialSvg++;

  // 官方 SVG 整包替换(纯图形)
  if (official && !svgPartial) {
    const icon = (ls.width || 0) <= 64 && (ls.height || 0) <= 64;
    const centered = centerSvgDecor(official);
    if (icon) { stat.rasterized++; return { kind: "icon", x: 0, y: 0, width: w, height: h, svg: centered, bitmap: true }; }
    return { kind: "icon", x: 0, y: 0, width: w, height: h, svg: centered, bitmap: icon };
  }
  // 小尺寸 svgPartial(带 LAYER 残影)→ LAYER 合成 rect,烘焙一张位图
  if (official && svgPartial && (ls.width || 0) <= 64 && (ls.height || 0) <= 64) {
    stat.rasterized++;
    let comp = official;
    const layers = (node.children || []).filter((k) => k.type === "LAYER" && (k.fill || k.backgroundColor) && k.layoutStyle);
    if (layers.length) {
      const hm = comp.match(/<svg[^>]*>/);
      if (hm) {
        const head = hm[0];
        const inner = comp.slice(head.length, comp.lastIndexOf("</svg>"));
        const headRects = [], tailRects = [];
        let seenVector = false;
        for (const k of node.children || []) {
          if (k.type === "LAYER" && (k.fill || k.backgroundColor) && k.layoutStyle) {
            const kl = k.layoutStyle;
            const color = paint(styles, k.fill || k.backgroundColor) || k.fill || k.backgroundColor;
            const r = `<rect x="${kl.relativeX ?? 0}" y="${kl.relativeY ?? 0}" width="${kl.width ?? 0}" height="${kl.height ?? 0}" fill="${color}"/>`;
            (seenVector ? tailRects : headRects).push(r);
          } else if (k.type === "PATH" || k.type === "GROUP" || k.type === "FRAME") seenVector = true;
        }
        comp = head + headRects.join("") + inner + tailRects.join("") + "</svg>";
      }
    }
    return { kind: "icon", x: 0, y: 0, width: w, height: h, svg: comp, bitmap: true };
  }

  // 容器
  if (isContainer) {
    const containerSize = { width: w ?? 0, height: h ?? 0 };
    const { mode, lay, kids } = decideLayout(containerSize, fi(node), node.children);
    stat.flexContainers++;
    const out = { kind: "container", x: 0, y: 0, width: w, height: h, ...st, children: [] };
    if (mode === "flex") {
      stat.flexPassed++;
      out.flex = {
        direction: lay.flexDirection,
        justifyContent: lay.justifyContent,
        alignItems: lay.alignItems,
        gap: lay.gap,
        padding: lay.padding,
      };
      let children = kids.map((k) => renderNode(k, styles));
      if (svgPartial) {
        const ex = extractIconClusters(official);
        if (ex.clusters.length) {
          stat.rasterized++;
          children = [
            { kind: "image", x: 0, y: 0, fill: "parent", svg: ex.bgSvg, bitmap: true },
            ...ex.clusters.map((c) => ({ kind: "icon", x: c.x, y: c.y, width: c.w, height: c.h, svg: c.svg, bitmap: true })),
            ...children,
          ];
        } else {
          children = [{ kind: "image", x: 0, y: 0, fill: "parent", svg: official, bitmap: true }, ...children];
        }
      }
      out.children = children;
      return out;
    }
    // absolute 模式:子节点按显式坐标
    stat.flexFallback++;
    const exClusters = svgPartial ? extractIconClusters(official) : null;
    const svgBbs = exClusters ? svgPathBBoxes(exClusters.bgSvg) : [];
    let filteredKids = kids.filter((k) => {
      if (!svgPartial || k.type !== "PATH" || officialSvgs.has(k.id)) return true;
      const kl = k.layoutStyle || {};
      const kb = [kl.relativeX ?? 0, kl.relativeY ?? 0, (kl.relativeX ?? 0) + kl.width, (kl.relativeY ?? 0) + kl.height];
      return !svgBbs.some((pb) => coverRatio(pb, kb) > 0.5);
    });
    // 同构兄弟 → component(模板 + 实例)
    const groups = new Map();
    const order = [];
    for (const k of filteredKids) {
      const fp = contentFingerprint(k);
      if (!groups.has(fp)) { groups.set(fp, []); order.push(fp); }
      groups.get(fp).push(k);
    }
    for (const fp of [...order]) {
      if (groups.get(fp).length !== 1) continue;
      const wfp = fp.replace(/\bE:(\d+x\d+)/g, "S:$1:*");
      if (wfp === fp) continue;
      const target = order.find((o) => o !== fp && wildcardMatch(wfp, o));
      if (target) {
        groups.get(target).push(groups.get(fp)[0]);
        groups.delete(fp);
      }
    }
    for (const [fp, list] of groups) {
      if (list.length >= 2) {
        stat.componentized++;
        const tplId = "tpl-" + globalTplIdx++;
        out.children.push({ kind: "component", id: tplId, template: renderNode(list[0], styles), instances: list.map((k) => { const kl = k.layoutStyle || {}; return { x: kl.relativeX ?? 0, y: kl.relativeY ?? 0 }; }) });
      } else {
        for (const k of list) {
          const kl = k.layoutStyle || {};
          const child = renderNode(k, styles);
          child.x = kl.relativeX ?? 0;
          child.y = kl.relativeY ?? 0;
          out.children.push(child);
        }
      }
    }
    if (svgPartial) {
      const ex = exClusters;
      if (ex.clusters.length) {
        stat.rasterized++;
        const iconPath = (node.children || []).find((k) => k.type === "PATH" && k.effect && effectStructured(styles, k.effect).blur != null && k.layoutStyle);
        if (iconPath && ex.clusters.length === 1) {
          const il = iconPath.layoutStyle;
          const c = ex.clusters[0];
          c.dx = (il.relativeX != null ? il.relativeX : c.x) - c.x;
          c.dy = (il.relativeY != null ? il.relativeY : c.y) - c.y;
        }
        out.children.unshift({ kind: "image", x: 0, y: 0, fill: "parent", svg: composeCardSvg(node, styles, ex), bitmap: true });
      } else {
        out.children.unshift({ kind: "image", x: 0, y: 0, fill: "parent", svg: official, bitmap: true, shadows: backdropShadows(node, styles) });
      }
    }
    return out;
  }

  // TEXT 叶子
  if (node.type === "TEXT") {
    stat.texts++;
    let textParts = node.text || [];
    if (textParts.length === 1 && /^T\d+\|/.test(textParts[0].text || "")) {
      const full = byId.get(node.id);
      if (full?.text) { textParts = full.text; stat.tokenResolved++; }
    }
    const fullText = textParts.map((t) => t.text).join("");
    const out = { kind: "text", x: 0, y: 0, width: w, height: h, text: fullText };
    const fv = fontValue(styles, textParts[0]?.font);
    if (fv) out.font = fv;
    const color = node._color || paint(styles, node.fill);
    if (color) {
      if (typeof color === "string" && color.startsWith("linear-gradient")) out.gradient = color;
      else out.color = color;
    }
    if (node.strokeColor && node.strokeWidth) {
      const sc = paint(styles, node.strokeColor);
      if (sc) out.stroke = { width: parseFloat(node.strokeWidth) || 0, color: sc };
    }
    if (node.textAlign === "center" || node.textAlign === "right") out.align = node.textAlign;
    if (fullText.includes("\n")) out.pre = true;
    else {
      const fs = styles[node.text?.[0]?.font]?.value?.size;
      const single = node.textMode === "single-line" || (h != null && fs != null && h <= fs * 1.6);
      if (single) out.nowrap = true;
    }
    if (node.letterSpacing) out.letterSpacing = node.letterSpacing;
    const teff = effectStructured(styles, node.effect);
    if (teff.shadows.length) out.shadows = teff.shadows;
    if (teff.blur != null) out.blur = teff.blur;
    // 多段 textColor 高亮(分段着色,中立表达)
    const tc = node.textColor || [];
    if (tc.length > 1 && textParts.length >= 1) {
      const highlights = [];
      let pos = 0;
      for (const seg of tc) {
        const end = seg.end ?? fullText.length;
        const segColor = seg.color ? (paint(styles, seg.color) || seg.color) : null;
        if (end > pos) highlights.push({ start: pos, end, color: segColor });
        pos = end;
      }
      out.highlights = highlights;
    }
    return out;
  }

  // PATH 叶子
  if (node.type === "PATH") {
    stat.pathFallback++;
    const paths = (node.path || []).map((p) => {
      const fill = p.fill ? (typeof p.fill === "string" && !p.fill.startsWith("paint_") ? p.fill : paint(styles, p.fill)) || "none" : "none";
      return `<path d="${p.data}" fill="${fill}"/>`;
    }).join("");
    const hasData = (node.path || []).some((p) => p.data);
    if (hasData) {
      const vw = w || 24, vh = h || 24;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}">${paths}</svg>`;
      return { kind: "icon", x: 0, y: 0, width: w, height: h, svg };
    }
    // data 剥离且无官方 SVG:几何背景块
    if (!st.bg) {
      const thin = (h != null && h <= 4) || (w != null && w <= 4);
      if (thin) { st.bg = "#E4E4E4"; stat.missingFill++; }
    }
    const m = node.path?.[0]?.transform;
    if (m) {
      const mm = m.match(/matrix\(([^)]+)\)/);
      if (mm) {
        const [a, b] = mm[1].split(",").map(Number);
        if (a && b !== undefined) {
          const rot = Math.round((Math.atan2(b, a) * 180) / Math.PI * 10) / 10;
          if (Math.abs(rot) > 0.5 && st.rotate == null) st.rotate = rot;
        }
      }
    }
    return { kind: "shape", x: 0, y: 0, width: w, height: h, ...st };
  }

  // LAYER / 其他
  const layer = { kind: "shape", x: 0, y: 0, width: w, height: h ?? 0, ...st };
  if (layer.height === 0 && w != null && w > 0) layer.height = 1; // hairline
  return layer;
}
function fi(node) { return node.flexContainerInfo; }

// ---------- 页面组装(→ 中立树) ----------
const rootSvg = draft.rootSvg;
// 页面背景:rootMeta.background 可能是样式引用(paint_2:161)→ 从整根 DSL 解析为设计色值
function pageBackground() {
  const bg = draft.rootMeta?.background;
  if (!bg) return "#FCFCFD";
  if (typeof bg === "string" && bg.startsWith("paint_")) {
    const v = fullDsl.styles?.[bg]?.value?.[0];
    if (typeof v === "string") return v;
  }
  return bg;
}
const page = { kind: "page", width: canvas.width, height: canvas.height, background: pageBackground(), children: [] };
if (rootSvg) {
  page.children.push({ kind: "image", x: rootSvg.x, y: rootSvg.y, width: rootSvg.w, height: rootSvg.h, svg: rootSvg.svg.replace(/^<\?xml[^?]*\?>\s*/i, ""), bitmap: true });
}
for (const s of draft.sections) {
  // 被 rootSvg 覆盖的 PATH:图形在切图里,跳过;inset effect 需补 CSS 覆盖层(切图不含 effect)
  if (rootSvg && s.type === "PATH") {
    const rootNode = s.dsl?.nodes?.[0];
    if (!rootNode) continue;
    const kl = rootNode.layoutStyle || {};
    const kb = [s.x, s.y, s.x + (kl.width ?? s.width), s.y + (kl.height ?? s.height)];
    const covered = svgPathBBoxes(rootSvg.svg).some((pb) => coverRatio(pb, kb) > 0.5);
    if (covered) {
      stat.rootSvgCovered++;
      const dsl0 = byId.get(rootNode.id);
      const effKey = dsl0?.effects ?? dsl0?.effect;
      // rootSvg 官方导出 svg 不含 effect → CSS 覆盖层是内阴影唯一来源,必须输出;
      // 仅当 statCards 已把内阴影烘焙进卡位图时才跳过
      if (effKey && !(draft.statCards && draft.statCards.length)) {
        const eff = effectStructured(s.dsl?.styles, effKey);
        if (eff.shadows.length) {
          page.children.push({ kind: "shape", x: s.x, y: s.y, width: s.width, height: s.height, radius: radiusValue(rootNode), shadows: eff.shadows });
        }
      }
      continue;
    }
  }
  if (!s.dsl) { stat.droppedSections++; continue; }
  const rootNode = s.dsl.nodes?.[0];
  if (!rootNode) { stat.droppedSections++; continue; }
  if (isChromeLayer(rootNode)) { stat.chromeSkipped++; continue; }
  const inner = renderNode(rootNode, s.dsl.styles);
  inner.x = s.x;
  inner.y = s.y;
  page.children.push(inner);
}

const tree = { meta: { canvas: { width: canvas.width, height: canvas.height, background: page.background }, diagnostics: stat, generator: "render-dsl.mjs", format: "neutral-render-tree-v1" }, root: page };
fs.writeFileSync(OUT, JSON.stringify(tree), "utf8");
console.log("written:", OUT, `${(JSON.stringify(tree).length / 1024).toFixed(1)}KB`);
console.log("诊断:", JSON.stringify(stat));