// restore-demo.mjs — 用 classify + inferLayout 管线把 MasterGo DSL 还原为 HTML,
// 并在页面内嵌几何测量脚本: 每个节点渲染后的 rect vs 设计稿坐标, 输出误差报告。
// 用法: node scripts/restore-demo.mjs <dsl.json> <out.html>
import { readFileSync, writeFileSync } from "node:fs";
import { classifyDsl, paintValue, svgOf } from "../packages/layout-infer/src/classify.js";
import { inferLayout } from "../packages/shared/src/layout-core.js";

const [, , dslPath = "/tmp/mg-mcp/dsl.json", outPath = "/tmp/restore/index.html"] = process.argv;
const raw = readFileSync(dslPath, "utf8");
const data = JSON.parse(raw.includes("=== RESULT ===") ? raw.split("=== RESULT ===")[1].trim() : raw);
const dsl = data.dsl ?? data;
const styles = dsl.styles || {};

const round = (n) => Math.round((n || 0) * 100) / 100;

// paint 引用 -> CSS background 值
function bgOf(node) {
  const v = paintValue(styles, node.fill);
  if (Array.isArray(v)) return v[0];
  if (typeof v === "string") return v;
  return null;
}
function colorOf(ref) {
  const v = paintValue(styles, ref);
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : null;
}
function effectCss(node) {
  const v = paintValue(styles, node.effect);
  if (!Array.isArray(v)) return null;
  return v
    .map((s) => {
      if (typeof s !== "string") return null;
      if (s.startsWith("filter:")) return `filter:${s.slice(7)}`;
      if (s.startsWith("box-shadow:")) return `box-shadow:${s.slice(11)}`;
      return s;
    })
    .filter(Boolean)
    .join(";");
}
function fontCss(node) {
  const fonts = (node.text || []).map((t) => paintValue(styles, t.font)).filter(Boolean);
  const f = fonts[0];
  if (!f) return "";
  const css = [];
  if (f.family) css.push(`font-family:${JSON.stringify(f.family)}`);
  if (f.size != null) css.push(`font-size:${f.size}px`);
  if (f.weight) css.push(`font-weight:${f.weight}`);
  // lineHeight: "180" = 180%(百分数); "24px" = px; auto/-1/none/0 -> 忽略(浏览器 normal)
  if (f.lineHeight != null) {
    const lh = String(f.lineHeight);
    const num = parseFloat(lh);
    if (lh !== "auto" && lh !== "none" && lh !== "0" && !(num <= 0)) css.push(`line-height:${lh.endsWith("px") ? lh : lh + "%"}`);
  }
  // letterSpacing: "-0.3px" -> px; auto/none -> 忽略
  if (f.letterSpacing != null) {
    const ls = String(f.letterSpacing);
    if (ls.endsWith("px")) css.push(`letter-spacing:${ls}`);
  }
  if (f.decoration && f.decoration !== "none") css.push(`text-decoration:${f.decoration}`);
  if (f.case && f.case !== "none") css.push(`text-transform:${f.case}`);
  return css.join(";");
}

// 解析 MasterGo padding 字符串 -> [top, right, bottom, left]
function parsePadding(s) {
  if (!s) return null;
  const v = String(s).replace(/px/g, "").trim().split(/\s+/).map(Number);
  if (v.length === 1) return [v[0], v[0], v[0], v[0]];
  if (v.length === 2) return [v[0], v[1], v[0], v[1]];
  if (v.length === 3) return [v[0], v[1], v[2], v[1]];
  return v;
}
// 解析 MasterGo gap 字符串 -> [rowGap, colGap]
function parseGap(s) {
  if (!s) return 0;
  const v = String(s).replace(/px/g, "").trim().split(/\s+/).map(Number);
  return v.length > 1 ? v : [v[0], v[0]];
}
// flex 流预测: 锚定法 — 第一个非负/非旋转子元素为流内锚点,
// 后续元素按"锚点 + 流内兄弟尺寸累计 + gap"预测; 偏差 > 12px 且锚点本身与 padding 起点一致 -> absolute
// 仅对 column 容器 + 无 space-between 的 row 容器生效(其余场景保持现状)
function findOutOfFlow(fi, ls, kids) {
  const out = new Set();
  if (!fi || !fi.flexDirection || kids.length < 2) return out;
  const dir = fi.flexDirection === "row" ? "row" : "column";
  const jc = fi.justifyContent;
  if (dir === "row" && (jc === "space-between" || jc === "space-around" || jc === "space-evenly")) return out;
  const pad = parsePadding(fi.padding);
  const gap = parseGap(fi.gap);
  const mainGap = dir === "row" ? gap[1] ?? 0 : gap[0] ?? 0;
  const mainStart = dir === "row" ? (pad ? pad[3] : 0) : (pad ? pad[0] : 0);
  // 锚点: 第一个未被负坐标/旋转规则覆盖的子元素
  let anchor = null;
  for (const k of kids) {
    const kls = k.layoutStyle || {};
    if ((kls.relativeX ?? 0) >= -0.5 && (kls.relativeY ?? 0) >= -0.5 && !kls.rotate) { anchor = k; break; }
  }
  if (!anchor) return out;
  const als = anchor.layoutStyle || {};
  const anchorMain = dir === "row" ? als.relativeX ?? 0 : als.relativeY ?? 0;
  if (Math.abs(anchorMain - mainStart) > 12) return out; // padding 解析不可靠, 放弃判定
  // 从锚点起逐元素预测
  let acc = anchorMain;
  let started = false;
  for (const k of kids) {
    const kls = k.layoutStyle || {};
    if (!started) {
      if (k.id === anchor.id) { started = true; acc += (dir === "row" ? kls.width ?? 0 : kls.height ?? 0) + mainGap; }
      else out.add(k.id); // 锚点之前的元素 = 绝对定位层
      continue;
    }
    const main = dir === "row" ? kls.width ?? 0 : kls.height ?? 0;
    const actMain = dir === "row" ? kls.relativeX ?? 0 : kls.relativeY ?? 0;
    if (Math.abs(actMain - acc) > 12) { out.add(k.id); } // 偏差大 -> absolute, 不占位
    else acc += main + mainGap;
  }
  return out;
}

// 绝对坐标 = 累计 relativeX/Y
let expected = [];

function gen(node, parentAbs, absX, absY, parentOid, parentOutOfFlow) {
  const ls = node.layoutStyle || {};
  const kids = node.children || [];
  const fi = node.flexContainerInfo || {};
  // flex 流预测: 找出 absolute 子元素(装饰层等)
  const outOfFlowKids = fi.flexDirection ? findOutOfFlow(fi, ls, kids) : new Set();
  const oid = node.id;
  const exp = {
    x: round(absX + (ls.relativeX ?? 0)),
    y: round(absY + (ls.relativeY ?? 0)),
    w: round(ls.width ?? 0),
    h: round(ls.height ?? 0),
  };
  expected.push({ oid, ...exp, r: ls.rotate ?? 0 });

  const css = [];
  css.push("box-sizing:border-box");
  css.push("position:relative");
  css.push("flex:0 0 auto"); // 尺寸定死, 不参与 flex 伸缩(还原场景)
  // 绝对定位: 拍平/旋转节点
  const abs = parentAbs || ls.rotate || (fi.flexDirection ? false : null);
  const isAbs = !!ls.rotate || (parentAbs === true) || (!fi.flexDirection && false);
  // 原生 flex 容器: 布局语义直读; 非 flex 容器若几何反推为 absolute 也按绝对定位
  let inferred = null;
  if (kids.length > 0 && ls.width && ls.height) {
    inferred = inferLayout({
      container: { width: ls.width, height: ls.height },
      children: kids.map((k) => {
        const kls = k.layoutStyle || {};
        return { id: k.id, x: kls.relativeX ?? 0, y: kls.relativeY ?? 0, width: kls.width, height: kls.height, rotation: kls.rotate ?? 0 };
      }),
    });
  }
  const nativeFlex = !!(fi.flexDirection && fi.flexDirection !== "none");
  // 负坐标子元素 / 流预测偏差 = MasterGo 绝对定位层(氛围光/装饰), 不参与 flex 流
  const outOfFlow = (ls.relativeX ?? 0) < -0.5 || (ls.relativeY ?? 0) < -0.5 || outOfFlowKids.has(oid);
  const forceAbs = ls.rotate || outOfFlow || (parentOutOfFlow && parentOutOfFlow.has(oid)) || (!nativeFlex && inferred?.position === "absolute");
  if (forceAbs) {
    css.push(`position:absolute;left:${ls.relativeX ?? 0}px;top:${ls.relativeY ?? 0}px`);
    css.push(`width:${ls.width ?? 0}px;height:${ls.height ?? 0}px`);
  } else if (nativeFlex) {
    const dir = fi.flexDirection === "row" ? "row" : "column";
    css.push(`display:flex;flex-direction:${dir}`);
    if (fi.alignItems) css.push(`align-items:${fi.alignItems}`);
    if (fi.justifyContent) css.push(`justify-content:${fi.justifyContent}`);
    // 1:1 还原: 尺寸直接用设计稿渲染值(auto 容器也固定), flex 只负责排列
    if (ls.width != null) css.push(`width:${ls.width}px`);
    if (ls.height != null) css.push(`height:${ls.height}px`);
    // MasterGo flexContainerInfo 直读 gap/padding(格式 "24px 24px" / "40px"),优先于几何反推
    if (fi.gap) css.push(`gap:${fi.gap}`);
    if (fi.padding) css.push(`padding:${fi.padding}`);
    if (inferred) {
      if (inferred.justifyContent && inferred.justifyContent !== "flex-start") css.push(`justify-content:${inferred.justifyContent}`);
    }
  } else {
    // 无原生 flex
    if (parentAbs) {
      // 拍平上下文: 一律 absolute 精确落位(不做几何 flex 反推 — 单子元素歧义会导致堆叠错乱)
      css.push(`position:absolute;left:${ls.relativeX ?? 0}px;top:${ls.relativeY ?? 0}px`);
      css.push(`width:${ls.width ?? 0}px;height:${ls.height ?? 0}px`);
    } else if (kids.length > 0) {
      if (inferred?.position === "flex") {
        css.push(`display:flex;flex-direction:${inferred.flexDirection}`);
        if (inferred.alignItems) css.push(`align-items:${inferred.alignItems}`);
        if (inferred.gap != null && inferred.gap !== 0) css.push(`gap:${inferred.gap}px`);
        if (inferred.justifyContent && inferred.justifyContent !== "flex-start") css.push(`justify-content:${inferred.justifyContent}`);
        if (inferred.padding) css.push(`padding:${inferred.padding.map((p) => `${p}px`).join(" ")}`);
      } else if (inferred?.position === "absolute") {
        css.push(`position:absolute;left:${ls.relativeX ?? 0}px;top:${ls.relativeY ?? 0}px`);
        css.push(`width:${ls.width ?? 0}px;height:${ls.height ?? 0}px`);
      }
      if (ls.width != null) css.push(`width:${ls.width}px`);
      if (ls.height != null) css.push(`height:${ls.height}px`);
    } else {
      // 叶子: 仅拍平上下文(parentAbs)需绝对定位, 否则由父 flex 布局流动
      if (parentAbs) {
        css.push(`position:absolute;left:${ls.relativeX ?? 0}px;top:${ls.relativeY ?? 0}px`);
        css.push(`width:${ls.width ?? 0}px;height:${ls.height ?? 0}px`);
      } else {
        if (ls.width != null) css.push(`width:${ls.width}px`);
        if (ls.height != null) css.push(`height:${ls.height}px`);
      }
    }
  }

  const eff = effectCss(node);
  if (eff) css.push(eff);

  // 内容
  let inner = "";
  if (node.type === "TEXT") {
    const text = (node.text || []).map((t) => t.text ?? "").join("");
    const color = colorOf(node.textColor?.[0]?.color) ?? node._color ?? "#111827";
    css.push(fontCss(node));
    css.push(`color:${color}`);
    if (node.textAlign && node.textAlign !== "left") css.push(`text-align:${node.textAlign}`);
    if (ls.width != null) css.push(`width:${ls.width}px`);
    const multi = node.textMode !== "single-line";
    css.push(multi ? "white-space:pre-wrap" : "white-space:nowrap;overflow:hidden");
    inner = escapeHtml(text);
  } else if (node.type === "PATH") {
    inner = svgOf(node, styles);
  } else {
    const bg = bgOf(node);
    if (bg) css.push(`background:${bg}`);
    if (node.borderRadius != null) {
      const br = String(node.borderRadius);
      css.push(`border-radius:${br.endsWith("px") ? br : br + "px"}`);
    }
    for (const c of kids) inner += gen(c, forceAbs || parentAbs, exp.x, exp.y, oid, outOfFlowKids);
  }
  if (ls.rotate) css.push(`transform:rotate(${ls.rotate}deg)`);

  return `<div data-oid="${oid}" data-parent="${parentOid || ""}" style="${escapeHtml(css.join(";"))}">${inner}</div>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const root = dsl.nodes[0];
const art = root.layoutStyle;
const body = gen(root, false, 0, 0, '', new Set());

// 测量脚本: 渲染后 rect vs 设计稿绝对坐标
const measureScript = `
<script>
(() => {
  try {
  document.getElementById('summary').textContent = 'js-ran';
  const artEl = document.getElementById('artboard');
  const artRect = artEl.getBoundingClientRect();
  const rows = ${JSON.stringify(expected)};
  const out = [];
  for (const r of rows) {
    const el = document.querySelector('[data-oid="' + r.oid + '"]');
    if (!el) { out.push({ oid: r.oid, missing: true }); continue; }
    const rect = el.getBoundingClientRect();
    const dx = rect.left - artRect.left - r.x;
    const dy = rect.top - artRect.top - r.y;
    const dw = rect.width - r.w;
    const dh = rect.height - r.h;
    // 文本行数检测: 叶子文本节点用 Range 取每行边界
    let lines = null;
    if (el.children.length === 0 && el.textContent && el.textContent.trim().length > 0) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rs = range.getClientRects();
      const rows = [];
      for (const r of rs) rows.push({ t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), rt: Math.round(r.right), w: Math.round(r.width) });
      // 按 top 分组为行
      const groups = [];
      for (const row of rows) {
        let g = groups.find(g => Math.abs(g.t - row.t) <= 2);
        if (!g) { g = { t: row.t, b: row.b, l: row.l, rt: row.rt, w: 0, n: 0 }; groups.push(g); }
        g.l = Math.min(g.l, row.l); g.rt = Math.max(g.rt, row.rt); g.n += 1;
      }
      lines = groups.map(g => ({ t: g.t, b: g.b, l: g.l, rt: g.rt, w: g.rt - g.l }));
    }
    out.push({ oid: r.oid, dx: +dx.toFixed(2), dy: +dy.toFixed(2), dw: +dw.toFixed(2), dh: +dh.toFixed(2), lines });
  }
  const err = (v) => Math.abs(v);
  const all = out.filter(o => !o.missing);
  const maxD = (k) => Math.max(...all.map(o => err(o[k])));
  const avgD = (k) => all.reduce((s, o) => s + err(o[k]), 0) / (all.length || 1);
  const rot = out.filter(o => (rows.find(r => r.oid === o.oid) || {}).r).length;
  const plain = all.filter(o => !(rows.find(r => r.oid === o.oid) || {}).r);
  const over2 = plain.filter(o => err(o.dx) > 2 || err(o.dy) > 2 || err(o.dw) > 2 || err(o.dh) > 2);
  const hit = plain.filter(o => err(o.dx) <= 1 && err(o.dy) <= 1 && err(o.dw) <= 1 && err(o.dh) <= 1).length;
  const avgP = (k) => plain.reduce((s, o) => s + err(o[k]), 0) / (plain.length || 1);
  const report = {
    total: all.length,
    plain: plain.length,
    rotated: rot,
    hit1px: hit,
    hitRate: +(hit / (plain.length || 1) * 100).toFixed(2),
    avg: { dx: +avgP('dx').toFixed(2), dy: +avgP('dy').toFixed(2), dw: +avgP('dw').toFixed(2), dh: +avgP('dh').toFixed(2) },
    max: { dx: +maxD('dx').toFixed(2), dy: +maxD('dy').toFixed(2), dw: +maxD('dw').toFixed(2), dh: +maxD('dh').toFixed(2) },
    over2px: over2.length,
    worst: over2.slice(0, 12).map(o => ({ oid: o.oid, dx: o.dx, dy: o.dy, dw: o.dw, dh: o.dh })),
  };
  document.getElementById('report').textContent = JSON.stringify(report, null, 2);
  // 局部误差: 子节点渲染位置相对父 vs 设计稿 relativeX/Y(消除级联)
  const rects = {};
  for (const r of rows) { const el = document.querySelector('[data-oid="' + r.oid + '"]'); if (el) rects[r.oid] = el.getBoundingClientRect(); }
  const rowById = {};
  for (const r of rows) rowById[r.oid] = r;
  const loc = [];
  for (const r of rows) {
    const el = document.querySelector('[data-oid="' + r.oid + '"]');
    if (!el) continue;
    const prect = el.dataset.parent ? rects[el.dataset.parent] : artRect;
    if (!prect) continue;
    const parentRow = el.dataset.parent ? (rowById[el.dataset.parent] || { x: 0, y: 0 }) : { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    loc.push({
      oid: r.oid,
      dx: +(rect.left - prect.left - (r.x - parentRow.x)).toFixed(2),
      dy: +(rect.top - prect.top - (r.y - parentRow.y)).toFixed(2),
      dw: +(rect.width - r.w).toFixed(2),
      dh: +(rect.height - r.h).toFixed(2),
      rct: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      par: [Math.round(prect.left), Math.round(prect.top), Math.round(prect.width), Math.round(prect.height)],
      exp: [r.x, r.y, r.w, r.h],
      lines: (out.find(o => o.oid === r.oid) || {}).lines || null,
    });
  }
  const lhit = loc.filter(o => Math.abs(o.dx) <= 1 && Math.abs(o.dy) <= 1 && Math.abs(o.dw) <= 1 && Math.abs(o.dh) <= 1).length;
  const lhitPos = loc.filter(o => Math.abs(o.dx) <= 1 && Math.abs(o.dy) <= 1).length;
  const lavg = (k) => loc.reduce((s, o) => s + Math.abs(o[k]), 0) / (loc.length || 1);
  document.getElementById('report').textContent += '\\nLOCAL\\n' + JSON.stringify(loc, null, 1);
  document.getElementById('summary').textContent =
    '绝对(非旋转): ' + plain.length + ' 节点 | ≤1px 命中 ' + report.hitRate + '% | 平均 dx=' + avgP('dx').toFixed(2) + ' dy=' + avgP('dy').toFixed(2) +
    ' dw=' + avgP('dw').toFixed(2) + ' dh=' + avgP('dh').toFixed(2) + ' | 超2px:' + over2.length + ' | 旋转节点 ' + rot + ' 个(包围盒不适用)' +
    '\\n' +
    '局部(相对父): 节点 ' + loc.length + ' | 位置≤1px ' + lhitPos + ' (' + (lhitPos / (loc.length || 1) * 100).toFixed(1) + '%) | 全维≤1px ' + lhit +
    ' | 平均局部误差 dx=' + lavg('dx').toFixed(2) + ' dy=' + lavg('dy').toFixed(2) + ' dw=' + lavg('dw').toFixed(2) + ' dh=' + lavg('dh').toFixed(2) +
    ' | 局部超2px: ' + loc.filter(o => Math.abs(o.dx) > 2 || Math.abs(o.dy) > 2 || Math.abs(o.dw) > 2 || Math.abs(o.dh) > 2).length;
  } catch (e) { document.getElementById('summary').textContent = 'ERR: ' + e.message; }
})();
</script>`;

// 几何对照层: 设计稿矩形(虚线框)叠加渲染, 肉眼验证
const overlay = expected
  .map((e) => `<div style="position:absolute;left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;border:1px dashed rgba(236,72,153,.55);pointer-events:none;box-sizing:border-box;z-index:9999"></div>`)
  .join("");

// Inter 字体内嵌(存在 fonts 目录时): 消除"系统无 Inter"导致的文本宽度/换行/观感差异
import { readFileSync as rfs, existsSync } from "node:fs";
let fontFaceCss = "";
const FONT_DIR = "/tmp/restore/fonts";
if (existsSync(FONT_DIR)) {
  const faces = [];
  for (const w of ["400", "500", "600", "700", "800"]) {
    const f = `${FONT_DIR}/inter-${w}.woff2`;
    if (!existsSync(f)) continue;
    const b64 = rfs(f).toString("base64");
    faces.push(`@font-face{font-family:"Inter";src:url(data:font/woff2;base64,${b64}) format("woff2");font-weight:${w};font-style:normal}`);
  }
  fontFaceCss = faces.join("\n");
}

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  ${fontFaceCss}
  body { margin: 0; background: #e5e7eb; font-family: system-ui, sans-serif; }
  #wrap { padding: 24px; }
  #summary { font: 13px/1.6 monospace; background: #111827; color: #34d399; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; white-space: pre-wrap; }
  #report { display: none; }
  #artboard { position: relative; width: ${art.width}px; height: ${art.height}px; margin: 0 auto; background: #fff; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.15); }
</style>
</head>
<body>
<div id="wrap">
  <div id="summary">measuring…</div>
  <pre id="report"></pre>
  <div id="artboard">${body}${overlay}</div>
</div>
${measureScript}
</body>
</html>`;

writeFileSync(outPath, html);
console.log(`written ${outPath} (${expected.length} nodes)`);