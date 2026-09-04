// render-dsl-html.mjs — 标准 DSL → HTML 渲染器 v2(还原能力验证)
// 策略:
//   1. flex 优先:有 flexContainerInfo 的容器,先用 simulateFlex 回写验证,
//      所有子节点位置与显式坐标偏差 ≤2px 才走 flex 流式;否则子节点按显式坐标 absolute
//   2. 文本 token(T4|xxx)从 dsl-full.json 全量文本补全
//   3. 多段 textColor → 语法高亮 span
//   4. 渐变文字 → background-clip:text;hairline(0/缺失高)→ 1px
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { simulateFlex } from "../../shared/dist/index.js";

// 用法:node render-dsl-html.mjs [fixtureDir]
// 输入:fixtureDir/{stacked-draft.json, dsl-full.json, svgs-official.json?}
// 输出:fixtureDir/demo.html
const DIR = process.argv[2] || fileURLToPath(new URL("../fixtures/mg-demo-2025", import.meta.url));
const DRAFT = `${DIR}/stacked-draft.json`;
const FULL = `${DIR}/dsl-full.json`;
const OUT = `${DIR}/demo.html`;

const draft = JSON.parse(fs.readFileSync(DRAFT, "utf8"));
const fullDsl = JSON.parse(fs.readFileSync(FULL, "utf8"));
const canvas = draft.canvas;
const stat = { flexContainers: 0, flexPassed: 0, flexFallback: 0, officialSvg: 0, pathFallback: 0, tokenResolved: 0, texts: 0, droppedSections: 0, missingFill: 0, chromeSkipped: 0, svgAligned: 0, rasterized: 0, componentized: 0, rootSvgCovered: 0 };
let globalTplIdx = 0; // 模板 id 全局唯一(多容器各自模板化会 id 冲突,运行时 clone 会取到错误的模板)
const SVGJSON = `${DIR}/svgs-official.json`;
const officialSvgs = new Map();
try {
  const svgData = JSON.parse(fs.readFileSync(SVGJSON, "utf8"));
  for (const s of svgData.svgs || []) officialSvgs.set(s.id, s.svg);
} catch { /* 无官方 SVG 时回退 path 拼装 */ }
// 状态栏/Home Indicator 层识别:含时钟文本(11:07)、Battery/信号/状态栏/Indicator 命名
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
// 子节点输出与定位合并:叶子输出(div 且 style 未声明 position)直接注入 position/left/top,避免冗余 wrapper 层
function withPos(html, kx, ky) {
  const pos = `position:absolute;left:${px(kx)}px;top:${px(ky)}px;`;
  const m = html.match(/^\s*<div style="/);
  if (m) {
    const insertAt = m[0].length;
    const styleEnd = html.indexOf('"', insertAt);
    if (styleEnd > 0) {
      const styleBody = html.slice(insertAt, styleEnd);
      // 按分号分段判断属性名,避免 background-position 误匹配 position
      const hasPosition = styleBody.split(";").some((seg) => /^\s*position\s*:/.test(seg));
      if (!hasPosition) return html.slice(0, insertAt) + pos + html.slice(insertAt);
      // 容器输出(position:relative):替换为注入定位——absolute 同样建立子节点定位上下文
      if (/position\s*:\s*relative/.test(styleBody)) {
        return html.slice(0, insertAt) + styleBody.replace(/position\s*:\s*relative/, `position:absolute;left:${px(kx)}px;top:${px(ky)}px`) + html.slice(styleEnd);
      }
    }
  }
  return `<div style="${pos}">${html}</div>`;
}
// 子树是否含真实内容(TEXT/LAYER)
function hasContent(n) {
  if (n.type === "TEXT" || n.type === "LAYER") return true;
  return (n.children || []).some(hasContent);
}
// svg 内容指纹:path bbox 序列(同组件不同实例导出内容相同 → 可复用;不同图标 → 区分)
function svgContentFingerprint(svg) {
  return svgPathBBoxes(svg).map((b) => b.map((v) => Math.round(v * 2) / 2).join(",")).join(";");
}
// 内容指纹:同构组件检测。整体替换 svg 用内容指纹(防 tab 图标误伤);纯容器忽略子结构
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
  // 无 svg 无 children 的纯容器(组件实例缺数据)→ 空指纹,可并入同尺寸整体替换 svg 组
  if (!kids && !hasContent(n)) return "E:" + size;
  return n.type + ":" + size + "[" + kids + "]";
}
// path d 坐标 → bbox [x0,y0,x1,y1]
function dbbox(d) {
  // 长小数(185.80001831054688)必须整体解析:拆分会得到 185 + 80001831054688,bbox 全错
  const nums = [...d.matchAll(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g)].map(Number);
  if (nums.length < 4) return null;
  const xs = [], ys = [];
  for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
// svg 内全部 path 的 bbox 列表
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
// 整体替换 svg 的装饰内容居中:背景 path(铺满 viewBox)不动,装饰 path(明显偏离中心的小图形)平移对齐 viewBox 中心
function centerSvgDecor(svg) {
  const vbm = svg.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/);
  if (!vbm) return svg;
  const [vx, vy, vw, vh] = vbm.slice(1).map(Number);
  const tags = [...svg.matchAll(/<path\b[^>]*?\/?>/g)].map((m) => m[0]);
  if (!tags.length) return svg;
  // 记录原始 tag 下标(缺 d 的 tag 跳过,但下标必须与 tags 对齐,不能 filter 后错位)
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
  if (Math.max(Math.abs(cx - vcx), Math.abs(cy - vcy)) <= 2) return svg; // 已居中
  if (bw >= vw * 0.85 || bh >= vh * 0.85) return svg; // 内容接近铺满,非装饰偏移
  // 贴边 = 设计定位(如头像胶囊内头像圆贴左上),不居中;不贴边才是导出偏移(如播放三角)
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

// svg 铺底:背景 PATH children 的 inset effect(统计卡内阴影)
function svgBackdropCss(node, styles, official) {
  const bgPath = (node.children || []).find((k) => k.type === "PATH" && k.effect && !officialSvgs.has(k.id));
  const shadows = bgPath ? effectCss(styles, bgPath.effect).boxShadows : [];
  return shadows.length ? `box-shadow:${shadows.join(",")};` : "";
}
// 整卡合成:背景 svg + 图标 cluster(svg feGaussianBlur)+ inset 内阴影(顶部渐变,形状复用背景圆角矩形)
// 目的:容器所有装饰样式烘焙进一张位图,CSS 只叠加动态文本——避免 CSS 组合还原不出设计稿效果
function composeCardSvg(node, styles, ex) {
  const bgSvg = ex.bgSvg;
  const head = (bgSvg.match(/<svg[^>]*>/) || [""])[0];
  if (!head) return bgSvg;
  const inner = bgSvg.slice(head.length, bgSvg.lastIndexOf("</svg>"));
  // children effect 分类:filters(blur)的 PATH = 图标;box-shadow inset 的 PATH = 背景
  let blurPx = null, insetColor = null;
  for (const k of node.children || []) {
    if (k.type !== "PATH" || !k.effect || officialSvgs.has(k.id)) continue;
    const eff = effectCss(styles, k.effect);
    if (eff.filters.length) {
      const m = eff.filters.join(" ").match(/blur\(([\d.]+)px\)/);
      if (m) blurPx = parseFloat(m[1]);
    }
    const sh = eff.boxShadows.join(" ");
    if (sh.includes("inset")) {
      const cm = sh.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/);
      if (cm) insetColor = cm[1];
    }
  }
  const nid = String(node.id || "card").replace(/[^a-zA-Z0-9]/g, "_");
  let defsExtra = "", extra = "";
  // 内阴影:顶部渐变色带,形状 = 背景第一个 path 的圆角矩形
  if (insetColor) {
    const dm = inner.match(/<path\b[^>]*\bd="([^"]+)"/);
    const vb = head.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/);
    const vbH = vb ? parseFloat(vb[4]) : 100;
    const pm = inner.match(/<path\b[^>]*>/);
    if (pm && vb) {
      const y2 = Math.min(0.5, 20 / vbH).toFixed(3);
      defsExtra += `<linearGradient id="${nid}_inset" x1="0" y1="0" x2="0" y2="${y2}"><stop offset="0" stop-color="${insetColor}" stop-opacity="0.9"/><stop offset="1" stop-color="${insetColor}" stop-opacity="0"/></linearGradient>`;
      // 克隆整条背景 path(d/transform/matrix 全保留),仅替换 fill 为内阴影渐变
      extra += pm[0].replace(/fill="[^"]*"/, `fill="url(#${nid}_inset)"`);
    }
  }
  // 图标 cluster:path 原坐标(相对整卡),平移对齐 DSL 权威坐标,svg 原生 blur
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
// 通配匹配:"S:size:*" 匹配 "S:size:<任意内容>"
function wildcardMatch(wfp, fp) {
  if (wfp === fp) return true;
  const re = new RegExp("^" + wfp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\\\*/g, ":.*") + "$");
  return re.test(fp);
}
// path d 数值平移(所有坐标对 +dx/+dy)
function shiftPathD(d, dx, dy) {
  let i = 0;
  return d.replace(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g, (m) => {
    const v = parseFloat(m);
    return String(i++ % 2 === 0 ? v + dx : v + dy);
  });
}
// matrix 变换后的 bbox(四角变换)
function matrixTransformBB(bb, m) {
  const [a, b, c, d, e, f] = m;
  const xs = [], ys = [];
  for (const [x, y] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]]) {
    xs.push(a * x + c * y + e);
    ys.push(b * x + d * y + f);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
// 背景 path 整体超出 viewBox(编组坐标导出)→ 平移进 viewBox;带 matrix 的 path 用变换后 bbox 判定,平移并入 matrix
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
      // d 可能被多个 path 复用,替换所有出现
      out = out.split(it.d).join(shiftPathD(it.d, dx, dy));
    }
  }
  return out;
}
// svg 内小 path cluster(面积 < svg 40%)→ 裁剪为独立图标 svg(如统计卡旗帜/时钟图标),背景保持铺底
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
    // path 上的 translate 并入 bbox(图标对齐产生的位移),子 svg 内不再带 transform
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
  // 背景 path 编组坐标超界 → 平移进 viewBox(统计卡背景被裁问题)
  bgSvg = shiftOutOfBoundsPaths(bgSvg, vb);
  // 渐变 stop0 透明 → 白色(渐变叠白底语义,避免卡内露出页面背景灰)
  bgSvg = bgSvg.replace(/<stop offset="0" stop-color="([^"]+)" stop-opacity="0"\s*\/?>/g, '<stop offset="0" stop-color="#FFFFFF"/>');
  return { bgSvg, clusters: [{ x: u[0], y: u[1], w, h, svg: clusterSvg }] };
}
// 两个 bbox 的相交面积占比(相对 kb 面积)
function coverRatio(pb, kb) {
  const ix = Math.min(pb[2], kb[2]) - Math.max(pb[0], kb[0]);
  const iy = Math.min(pb[3], kb[3]) - Math.max(pb[1], kb[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const kbArea = Math.max((kb[2] - kb[0]) * (kb[3] - kb[1]), 1);
  return (ix * iy) / kbArea;
}
// 整体替换的 svg:内容小图形(图标)按 DSL 子节点位置平移,修复导出坐标系偏移
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
  if (su[0] - vbX > 6 || su[1] - vbY > 6) return svg; // 小图形不在左上角,不猜
  // 与 DSL 子节点匹配:尺寸相近且中心最近
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
  // 目标节点必须完整落在挂载节点内(图标可在卡内任意位置,如右上角);超出则不可信
  if (best.kb[0] < -1 || best.kb[1] < -1 || best.kb[2] > vbW + 1 || best.kb[3] > vbH + 1) return svg;
  // 给小 path 加 transform
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
function officialSvgFor(node) {
  const raw = officialSvgs.get(node.id);
  if (!raw) return null;
  let svg = raw.replace(/<\?xml[^>]*\?>/, "").trim();
  // defs id 唯一化:多个官方 SVG 内联时渐变 id 冲突会导致 url(#) 引用串色
  const uniq = node.id.replace(/[^A-Za-z0-9]/g, "_");
  svg = svg.replace(/id="([^"]+)"/g, (m, id) => `id="${uniq}_${id}"`);
  svg = svg.replace(/url\(#([^)]+)\)/g, (m, id) => `url(#${uniq}_${id})`);
  const ls = node.layoutStyle || {};
  if (ls.width != null) svg = svg.replace(/width="[^"]*"/, `width="${px(ls.width)}"`);
  if (ls.height != null) svg = svg.replace(/height="[^"]*"/, `height="${px(ls.height)}"`);
  return svg;
}

// id → 节点 全量索引(用于 token 文本补全)
const byId = new Map();
(function index(n) { byId.set(n.id, n); (n.children || []).forEach(index); })(fullDsl.nodes[0]);

// ---------- 样式解析 ----------
function paint(styles, key) {
  if (!key) return null;
  const v = styles[key]?.value;
  if (!v) return null;
  const first = v[0];
  if (typeof first === "string") return first;
  if (first && first.url) return `url(${first.url})`;
  return null;
}
function fontCss(styles, key) {
  const f = styles[key]?.value;
  if (!f) return null;
  const parts = [];
  if (f.family) {
    // 未知字体(设计工具内置如 JoonFont)→ 窄数字字体回退链;中文自动落到 PingFang SC
    const fam = f.family.replace(/"/g, "");
    const known = new Set(["Inter", "PingFang SC", "Helvetica", "Arial", "sans-serif", "-apple-system"]);
    parts.push(known.has(fam)
      ? `font-family:'${fam}', -apple-system, 'PingFang SC', 'Helvetica Neue', Arial, sans-serif`
      : `font-family:'${fam}', 'DIN Alternate', 'Arial Narrow', -apple-system, 'PingFang SC', 'Helvetica Neue', Arial, sans-serif`);
  }
  if (f.size) parts.push(`font-size:${f.size}px`);
  if (f.weight) parts.push(`font-weight:${f.weight}`);
  if (f.lineHeight && f.lineHeight !== "auto" && f.lineHeight !== "-1") {
    const lh = parseFloat(f.lineHeight);
    if (!isNaN(lh)) {
      // MasterGo 语义:lineHeight >= 100 为百分比(如 180 → 1.8em),< 100 为绝对 px(如 18 → 18px)
      parts.push(lh >= 100 ? `line-height:${lh / 100}` : `line-height:${lh}px`);
    }
  }
  if (f.letterSpacing && f.letterSpacing !== "auto") parts.push(`letter-spacing:${f.letterSpacing}`);
  if (f.decoration && f.decoration !== "none") parts.push(`text-decoration:${f.decoration}`);
  if (f.case === "uppercase") parts.push("text-transform:uppercase");
  if (f.case === "capitalize") parts.push("text-transform:capitalize");
  return parts.join(";");
}
function effectCss(styles, key) {
  const out = { boxShadows: [], filters: [] };
  if (!key) return out;
  const v = styles[key]?.value;
  if (!v) return out;
  for (const s of v) {
    if (typeof s !== "string") continue;
    if (s.startsWith("box-shadow:")) out.boxShadows.push(s.replace(/^box-shadow:\s*/, "").replace(/;$/, ""));
    else if (s.startsWith("filter:")) out.filters.push(s.replace(/^filter:\s*/, "").replace(/;$/, ""));
  }
  return out;
}
// stroke → inset box-shadow(不占布局,与 strokeAlign=inside 一致;多边值如 "1px 0px 0px")
function strokeShadows(node, styles) {
  if (!node.strokeColor || !node.strokeWidth) return [];
  const color = paint(styles, node.strokeColor) || node.strokeColor;
  if (!color) return [];
  const vals = String(node.strokeWidth).split(/\s+/).map((v) => parseFloat(v) || 0);
  if (vals.length === 1 && vals[0] > 0) return [`inset 0 0 0 ${vals[0]}px ${color}`];
  const spec = [[0, 1], [-1, 0], [0, -1], [1, 0]]; // top/right/bottom/left
  const out = [];
  for (let i = 0; i < 4; i++) {
    const v = vals.length === 2 ? vals[i % 2] : vals.length === 3 ? (i === 3 ? vals[1] : vals[i]) : vals[i] ?? 0;
    if (v > 0) out.push(`inset ${spec[i][0]}px ${spec[i][1]}px 0 0 ${color}`);
  }
  return out;
}
function px(n) { return String(Math.round(n * 100) / 100); }
// borderRadius:字符串(如 "8px 24px 24px")原样输出;数组/数字转 px
function radiusCss(node) {
  const br = node.borderRadius;
  if (br == null || br === "") return "";
  if (typeof br === "string") return `border-radius:${br}`;
  if (Array.isArray(br)) return `border-radius:${br.map((v) => px(parseFloat(v)) + "px").join(" ")}`;
  return `border-radius:${px(parseFloat(br))}px`;
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
// 返回 { mode: "flex" | "absolute", children: 排序后的子节点 }
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

// ---------- 节点渲染 ----------
function renderNode(node, styles) {
  const ls = node.layoutStyle || {};
  const w = ls.width, h = ls.height;
  const size = (w != null ? `width:${px(w)}px;` : "") + (h != null ? `height:${px(h)}px;` : "");
  const fi = node.flexContainerInfo;
  const isContainer = Array.isArray(node.children) && node.children.length > 0;

  const common = [];
  common.push(size);
  let bg = node._color ? node._color : paint(styles, node.fill);
  if (!bg && node.type === "PATH") {
    for (const p of node.path || []) {
      const fl = p.fill;
      if (!fl || String(fl).startsWith("url(#")) continue; // 渐变 defs 引用不可直接作背景
      bg = typeof fl === "string" && !fl.startsWith("paint_") ? fl : paint(styles, fl);
      if (bg) break;
    }
  }
  if (bg) {
    if (typeof bg === "string" && bg.startsWith("url(")) common.push(`background-image:${bg};background-size:cover;background-position:center;`);
    else common.push(`background:${bg}`);
  }
  const rc = radiusCss(node);
  if (rc) common.push(rc);

  const eff = effectCss(styles, node.effect);
  const shadows = [...eff.boxShadows, ...strokeShadows(node, styles)];
  if (shadows.length) common.push(`box-shadow:${shadows.join(",")}`);
  if (eff.filters.length) common.push(`filter:${eff.filters.join(" ")}`);
  if (node.opacity != null) common.push(`opacity:${node.opacity}`);
  if (ls.rotate && Math.abs(ls.rotate) > 0.5) common.push(`transform:rotate(${Math.round(ls.rotate * 10) / 10}deg)`);
  const base = common.join(";");

  const official0 = officialSvgFor(node);
  // 容器(svgPartial)时小图形按 DSL 子节点对齐;纯图形整体替换直接使用
  const official = official0 && isContainer ? alignSvgToChildren(official0, node) : official0;
  // 官方 SVG 整包替换仅当子树纯图形(无 TEXT/LAYER 后代);否则 svg 铺底 + children 叠加
  const svgPartial = official && isContainer && (function hasExtra(n) {
    if (n.type === "TEXT" || n.type === "LAYER") return true;
    return (n.children || []).some(hasExtra);
  })(node);
  if (official) stat.officialSvg++;
  if (official && !svgPartial) {
    const icon = (ls.width || 0) <= 64 && (ls.height || 0) <= 64;
    const centered = centerSvgDecor(official);
    if (icon && /<svg[^>]*>/.test(centered)) {
      stat.rasterized++;
      return centered.replace(/^<svg/, '<svg class="mg-icon"');
    }
    return centered;
  }
  // 小尺寸 svgPartial(带 LAYER 残影的图标,如 tab 学习图标)→ LAYER 合成为 svg rect,与矢量内容烘焙成一张位图
  if (official && svgPartial && (ls.width || 0) <= 64 && (ls.height || 0) <= 64 && /<svg[^>]*>/.test(official)) {
    stat.rasterized++;
    let comp = official;
    // LAYER 子节点(选中指示块等真实内容):按 children 顺序转为 rect(首子=底层,插在矢量 paths 之前)
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
            const r = `<rect x="${px(kl.relativeX ?? 0)}" y="${px(kl.relativeY ?? 0)}" width="${px(kl.width ?? 0)}" height="${px(kl.height ?? 0)}" fill="${color}"/>`;
            (seenVector ? tailRects : headRects).push(r);
          } else if (k.type === "PATH" || k.type === "GROUP" || k.type === "FRAME") seenVector = true;
        }
        comp = head + headRects.join("") + inner + tailRects.join("") + "</svg>";
      }
    }
    return comp.replace(/^<svg/, '<svg class="mg-icon"');
  }

  if (isContainer) {
    const containerSize = { width: w ?? 0, height: h ?? 0 };
    const { mode, lay, kids } = decideLayout(containerSize, fi, node.children);
    stat.flexContainers++;
    if (mode === "flex") {
      stat.flexPassed++;
      const css = [`display:flex;flex-direction:${lay.flexDirection}`];
      if (lay.justifyContent && lay.justifyContent !== "flex-start") css.push(`justify-content:${lay.justifyContent}`);
      if (lay.alignItems === "center") css.push("align-items:center");
      else if (lay.alignItems === "end" || lay.alignItems === "flex-end") css.push("align-items:flex-end");
      if (lay.gap) css.push(`gap:${px(lay.gap)}px`);
      const [t, r, b, l] = lay.padding;
      if (t || r || b || l) css.push(`padding:${px(t)}px ${px(r)}px ${px(b)}px ${px(l)}px`);
      let inner = kids.map((k) => renderNode(k, styles)).join("\n");
      if (svgPartial) {
        const ex = extractIconClusters(official);
        if (ex.clusters.length) {
          stat.rasterized++;
          inner = `<div style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;">${ex.bgSvg.replace(/^<svg/, '<svg class="mg-bg"')}</div>\n${ex.clusters.map((c) => `<div style="position:absolute;left:${px(c.x)}px;top:${px(c.y)}px;width:${px(c.w)}px;height:${px(c.h)}px;">${c.svg.replace(/^<svg/, '<svg class="mg-icon"')}</div>`).join("\n")}\n${inner}`;
        } else {
          inner = `<div style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;">${official}</div>\n${inner}`;
        }
      }
      return `<div style="${base};${css.join(";")};position:relative;">\n${inner}\n</div>`;
    }
    // absolute 模式:子节点按显式坐标
    stat.flexFallback++;
    const exClusters = svgPartial ? extractIconClusters(official) : null;
    const svgBbs = exClusters ? svgPathBBoxes(exClusters.bgSvg) : [];
    let filteredKids = kids.filter((k) => {
      if (!svgPartial || k.type !== "PATH" || officialSvgs.has(k.id)) return true;
      // svg 铺底:若 svg 内容未覆盖该 PATH 区域(坐标系错位被裁)→ 保留几何 fallback
      const kl = k.layoutStyle || {};
      const kb = [kl.relativeX ?? 0, kl.relativeY ?? 0, (kl.relativeX ?? 0) + kl.width, (kl.relativeY ?? 0) + kl.height];
      return !svgBbs.some((pb) => coverRatio(pb, kb) > 0.5);
    });
    // 同构兄弟检测 → 组件模板 + 实例(复用,不重复渲染)
    let inner = "";
    const groups = new Map();
    const order = [];
    for (const k of filteredKids) {
      const fp = contentFingerprint(k);
      if (!groups.has(fp)) { groups.set(fp, []); order.push(fp); }
      groups.get(fp).push(k);
    }
    // 单例"空实例"组(指纹含 E:size)通配并入同尺寸整体替换 svg 组件组(课程卡等组件实例缺数据)
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
    const tpls = [];
    for (const [fp, list] of groups) {
      if (list.length >= 2) {
        stat.componentized++;
        const tplId = "tpl-" + globalTplIdx++;
        tpls.push(`<template id="${tplId}">${renderNode(list[0], styles)}</template>`);
        for (const k of list) {
          const kl = k.layoutStyle || {};
          inner += `\n<div style="position:absolute;left:${px(kl.relativeX ?? 0)}px;top:${px(kl.relativeY ?? 0)}px;" data-tpl="${tplId}"></div>`;
        }
      } else {
        for (const k of list) {
          const kl = k.layoutStyle || {};
          const kx = kl.relativeX ?? 0, ky = kl.relativeY ?? 0;
          inner += "\n" + withPos(renderNode(k, styles), kx, ky);
        }
      }
    }
    if (tpls.length) inner = tpls.join("\n") + inner;
    if (svgPartial) {
      const ex = exClusters;
      if (ex.clusters.length) {
        stat.rasterized++;
        // 图标 cluster 平移量:DSL 权威坐标 - svg 坐标(svg 导出坐标与 DSL 有 ~2px 系统偏差)
        const iconPath = (node.children || []).find((k) => k.type === "PATH" && k.effect && effectCss(styles, k.effect).filters.length && k.layoutStyle);
        if (iconPath && ex.clusters.length === 1) {
          const il = iconPath.layoutStyle;
          const c = ex.clusters[0];
          c.dx = (il.relativeX != null ? il.relativeX : c.x) - c.x;
          c.dy = (il.relativeY != null ? il.relativeY : c.y) - c.y;
        }
        // 整卡合成:背景+内阴影+图标(blur)烘焙成一张位图,CSS 只叠加文本
        const cardSvg = composeCardSvg(node, styles, ex);
        inner = `<div style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;">${cardSvg.replace(/^<svg/, '<svg class="mg-bg"')}</div>\n${inner}`;
      } else {
        inner = `<div style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;${svgBackdropCss(node, styles, official)}">${official}</div>\n${inner}`;
      }
    }
    return `<div style="${base};position:relative;">\n${inner}\n</div>`;
  }

  // TEXT 叶子
  if (node.type === "TEXT") {
    stat.texts++;
    // token 文本补全(长文本被 MCP token 化,从整根 DSL 按 id 取真实内容)
    let textParts = node.text || [];
    if (textParts.length === 1 && /^T\d+\|/.test(textParts[0].text || "")) {
      const full = byId.get(node.id);
      if (full?.text) { textParts = full.text; stat.tokenResolved++; }
    }
    const fullText = textParts.map((t) => t.text).join("");
    const css = [];
    const fc = fontCss(styles, textParts[0]?.font);
    if (fc) css.push(fc);
    const color = node._color || paint(styles, node.fill);
    if (color) {
      if (typeof color === "string" && color.startsWith("linear-gradient")) {
        css.push(`background-image:${color};-webkit-background-clip:text;background-clip:text;color:transparent`);
      } else {
        css.push(`color:${color}`);
      }
    }
    // 描边(数字白描边 2.5px outside 等;TEXT 的 stroke 语义 = 文字描边)
    if (node.strokeColor && node.strokeWidth) {
      const sc = paint(styles, node.strokeColor);
      if (sc) css.push(`-webkit-text-stroke:${node.strokeWidth} ${sc}`);
    }
    if (node.textAlign === "center") css.push("text-align:center");
    else if (node.textAlign === "right") css.push("text-align:right");
    if (fullText.includes("\n")) css.push("white-space:pre");
    else {
      // 单行判定:显式 single-line,或设计高度 ≤ 1.6×字号(防意外换行破坏布局)
      const fs = styles[node.text?.[0]?.font]?.value?.size;
      const single = node.textMode === "single-line" || (h != null && fs != null && h <= fs * 1.6);
      if (single) css.push("white-space:nowrap");
    }
    if (node.letterSpacing) css.push(`letter-spacing:${node.letterSpacing}`);
    // effect:投影/滤镜(数字大字的淡投影 0 1px 6px 等)
    const teff = effectCss(styles, node.effect);
    if (teff.boxShadows.length) css.push(`box-shadow:${teff.boxShadows.join(",")}`);
    if (teff.filters.length) css.push(`filter:${teff.filters.join(" ")}`);
    // 尺寸保留(布局模拟需要);绝不继承 base——TEXT 的 fill/_color 是文字色,不是背景色
    if (w != null) css.push(`width:${px(w)}px`);
    if (h != null) css.push(`height:${px(h)}px`);
    // 多段 textColor 高亮
    const tc = node.textColor || [];
    let body;
    if (tc.length > 1 && textParts.length >= 1) {
      const segs = [];
      let pos = 0;
      for (const seg of tc) {
        const end = seg.end ?? fullText.length;
        const segColor = seg.color ? (paint(styles, seg.color) || seg.color) : null;
        const t = fullText.slice(pos, end);
        if (t) segs.push(segColor ? `<span style="color:${segColor}">${esc(t)}</span>` : esc(t));
        pos = end;
      }
      if (pos < fullText.length) segs.push(esc(fullText.slice(pos)));
      body = segs.join("");
    } else {
      body = esc(fullText);
    }
    return `<div style="${css.join(";")}">${body}</div>`;
  }

  // PATH 叶子 → SVG
  if (node.type === "PATH") {
    stat.pathFallback++;
    const paths = (node.path || []).map((p) => {
      const fill = p.fill ? (typeof p.fill === "string" && !p.fill.startsWith("paint_") ? p.fill : paint(styles, p.fill)) || "none" : "none";
      return `<path d="${p.data}" fill="${fill}"/>`;
    }).join("");
    const hasData = (node.path || []).some((p) => p.data);
    if (hasData) {
      const vw = w || 24, vh = h || 24;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${px(vw)}" height="${px(vh)}" viewBox="0 0 ${px(vw)} ${px(vh)}">${paths}</svg>`;
    }
    // data 被剥离且无官方 SVG:按几何渲染背景块;path[].transform 的旋转角补进 transform
    if (!common.join(";").includes("background:")) {
      // 数据缺失兜底:无 fill 的细条(进度条/分隔线)→ 中性灰;记录 warning
      const thin = (h != null && h <= 4) || (w != null && w <= 4);
      if (thin) { common.push("background:#E4E4E4"); stat.missingFill++; }
    }
    const m = node.path?.[0]?.transform;
    if (m) {
      const mm = m.match(/matrix\(([^)]+)\)/);
      if (mm) {
        const [a, b] = mm[1].split(",").map(Number);
        if (a && b !== undefined) {
          const rot = Math.round((Math.atan2(b, a) * 180) / Math.PI * 10) / 10;
          if (Math.abs(rot) > 0.5 && !/transform:/.test(base)) common.push(`transform:rotate(${rot}deg)`);
        }
      }
    }
    return `<div style="${common.join(";")}"></div>`;
  }

  // LAYER / 其他(hairline:0/缺失 高宽条 → 1px)
  const hairline = (w != null && w > 0 && (h == null || h === 0)) ? `height:1px;` : "";
  return `<div style="${hairline}${base}"></div>`;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------- 组装页面 ----------
const rootSvg = draft.rootSvg;
const sectionsHtml = draft.sections.map((s) => {
  if (rootSvg && s.type === "PATH") {
    const kb = [s.x, s.y, s.x + (s.width || 0), s.y + (s.height || 0)];
    if (coverRatio([rootSvg.x, rootSvg.y, rootSvg.x + rootSvg.w, rootSvg.y + rootSvg.h], kb) > 0.5) {
      stat.rootSvgCovered++;
      // 被根 svg 覆盖的 PATH:svg 已含其图形,但其 inset 阴影 effect 需 CSS 覆盖层补回
      // (若 statCards 烘焙了该区域,内阴影已在卡位图中,不再输出覆盖层)
      const dsl0 = s.dsl?.nodes?.[0];
      const effKey = dsl0?.effects ?? dsl0?.effect;
      // rootSvg 官方导出 svg 不含 effect(内阴影是 DSL 层属性)→ CSS 覆盖层是内阴影唯一来源,
      // 必须输出;仅当 statCards 已把内阴影烘焙进卡位图时才跳过
      if (effKey && !(draft.statCards && draft.statCards.length)) {
        const ec = effectCss(s.dsl?.styles || {}, effKey);
        if (ec?.boxShadows?.some((sh) => sh.includes("inset"))) {
          const r = radiusCss(dsl0);
          const sh = ec.boxShadows.filter((x) => x.includes("inset")).join(",");
          return `<div style="position:absolute;left:${px(s.x)}px;top:${px(s.y)}px;width:${px(s.width)}px;height:${px(s.height)}px;${r ? `border-radius:${r};` : ""}box-shadow:${sh};"></div>`;
        }
      }
      return "";
    }
  }
  const dsl = s.dsl;
  if (!dsl || !dsl.nodes || !dsl.nodes[0]) return "";
  const rootNode = dsl.nodes[0];
  // 废弃图层过滤:整个 bbox 在画布外(设计稿遗留的拖出元素),跳过不渲染
  const outX = s.x + s.width < 0 || s.x > canvas.width;
  const outY = s.y + s.height < 0 || s.y > canvas.height;
  if (outX || outY) { stat.droppedSections++; return ""; }
  // 状态栏/Home Indicator:只保留位置高度(安全区),不渲染内容
  if (isChromeLayer(rootNode)) { stat.chromeSkipped++; return ""; }
  const inner = renderNode(rootNode, dsl.styles);
  return `<div style="position:absolute;left:${s.x}px;top:${s.y}px;width:${s.width}px;height:${s.height}px;">${inner}</div>`;
}).join("\n");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<title>MasterGo MCP 介绍文档 — DSL 还原</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${draft.rootMeta?.background || '#FCFCFD'}; display: flex; justify-content: center; padding: 24px 0; }
  #canvas { position: relative; width: ${canvas.width}px; height: ${canvas.height}px; background: ${draft.rootMeta?.background || '#FCFCFD'}; overflow: hidden; }
</style>
</head>
<body>
<div id="canvas">
${rootSvg ? `<div style="position:absolute;left:${px(rootSvg.x)}px;top:${px(rootSvg.y)}px;width:${px(rootSvg.w)}px;height:${px(rootSvg.h)}px;overflow:hidden;">${rootSvg.svg.replace(/^<\?xml[^?]*\?>\s*/i, "").replace(/^<svg/, '<svg class="mg-bg"')}</div>` : ""}
${sectionsHtml}
</div>
<script>
(function () {
  // 组件模板实例化:clone 时重写 id 与 url(#) 引用,避免多实例 defs 冲突
  let copySeq = 0;
  document.querySelectorAll("[data-tpl]").forEach((el) => {
    const tpl = document.getElementById(el.getAttribute("data-tpl"));
    if (!tpl) return;
    const copy = tpl.content.cloneNode(true);
    const suffix = "-i" + (++copySeq);
    const idMap = new Map();
    copy.querySelectorAll("[id]").forEach((x) => { idMap.set(x.id, x.id + suffix); x.id = x.id + suffix; });
    if (idMap.size) {
      copy.querySelectorAll("*").forEach((x) => {
        for (const attr of x.attributes) {
          if (typeof attr.value === "string" && attr.value.includes("url(#")) {
            attr.value = attr.value.replace(/url\(#([^)]+)\)/g, (m, id) => (idMap.has(id) ? "url(#" + id + suffix + ")" : m));
          }
        }
      });
    }
    el.appendChild(copy);
    el.removeAttribute("data-tpl");
  });
  // svg → 4x 高质量 webp(不支持 webp 时回退 png):小图标(mg-icon)与容器背景(mg-bg)统一位图化
  const icons = document.querySelectorAll("svg.mg-icon, svg.mg-bg");
  if (!icons.length) return;
  const toUrl = (svg, w, h) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * 4));
        c.height = Math.max(1, Math.round(h * 4));
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, c.width, c.height);
        let url = c.toDataURL("image/webp", 0.92);
        if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/png");
        resolve(url);
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    const str = new XMLSerializer().serializeToString(svg);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(str);
  });
  (async () => {
    for (const svg of icons) {
      const w = svg.getAttribute("width") || svg.clientWidth || 24;
      const h = svg.getAttribute("height") || svg.clientHeight || 24;
      const url = await toUrl(svg, w, h);
      if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.style.width = w + "px";
        img.style.height = h + "px";
        img.style.display = "block";
        svg.replaceWith(img);
      }
    }
  })();
})();
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html, "utf8");
console.log("written:", OUT, `${(html.length / 1024).toFixed(1)}KB`);
console.log("诊断:", JSON.stringify(stat));