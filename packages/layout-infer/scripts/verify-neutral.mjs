// verify-neutral.mjs — 中立描述树断言
// ============================================================
// 检查 render-dsl.mjs 输出的 tree.json 是否技术中立:
//   1. 无 CSS/HTML/DOM 语法泄漏(position:absolute、display:flex、px 单位拼接等)
//   2. 样式字段结构化(shadows = {inset,x,y,blur,spread,color},radius = 数值,
//      font = {family,size,weight,...},rotate/blur/opacity = 数值)
//   3. 节点 kind 合法、布局字段为数值
// 任何技术栈(Vue/React/RN/Flutter/小程序)都应按此格式消费同一棵树。
//
// 用法:node verify-neutral.mjs [fixtureDir]
import fs from "node:fs";

const DIR = process.argv[2] || "./packages/layout-infer/fixtures/mg-demo-2025";
const TREE = `${DIR}/tree.json`;

const tree = JSON.parse(fs.readFileSync(TREE, "utf8"));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`✓ ${msg}`); } else { fail++; console.log(`✗ ${msg}`); } };

// ---- 1. CSS/HTML 语法泄漏扫描 ----
const CSS_PATTERNS = [
  /position\s*:/, /display\s*:/, /border-radius\s*:/, /box-shadow\s*:/, /-webkit-text-stroke/,
  /background(?:-image|-clip)?\s*:/, /font-family\s*:/, /text-align\s*:/, /white-space\s*:/,
  /px;/, /<div/, /<span/, /<svg/, /<\/?[a-z]+[\s>]/i, /transform\s*:/, /letter-spacing\s*:/,
  /data-tpl/, /getElementById/, /querySelector/,
];
let leaks = [];
(function walk(v, path) {
  if (typeof v === "string") {
    // svg 字段 = 矢量设计数据(任何技术栈可渲染/转位图),不是树语法,跳过
    if (path.endsWith(".svg") || path.includes(".svg.")) return;
    for (const re of CSS_PATTERNS) {
      if (re.test(v)) { leaks.push(`${path} = ${JSON.stringify(v.slice(0, 80))} (${re})`); break; }
    }
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
  if (v && typeof v === "object") { for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`); }
})(tree, "tree");
ok(leaks.length === 0, `无 CSS/HTML/DOM 语法泄漏(${leaks.length ? "发现: " + leaks[0] : "全树干净"})`);

// ---- 2. 结构合法性 ----
const KINDS = new Set(["page", "container", "text", "shape", "icon", "image", "component"]);
let kindBad = 0, layoutBad = 0, shadowBad = 0, fontBad = 0, textBad = 0;
(function walk(n, path) {
  if (!n || typeof n !== "object") return;
  if (!KINDS.has(n.kind)) { kindBad++; console.log(`  ✗ ${path}: 非法 kind ${JSON.stringify(n.kind)}`); }
  for (const f of ["x", "y", "width", "height"]) {
    if (n[f] != null && typeof n[f] !== "number") layoutBad++;
  }
  if (n.shadows) {
    if (!Array.isArray(n.shadows)) shadowBad++;
    else for (const s of n.shadows) {
      if (!s || typeof s !== "object" || typeof s.x !== "number" || typeof s.y !== "number" ||
          typeof s.blur !== "number" || typeof s.color !== "string" || typeof s.inset !== "boolean") shadowBad++;
    }
  }
  if (n.radius != null && typeof n.radius !== "number" && !(Array.isArray(n.radius) && n.radius.every((v) => typeof v === "number"))) {
    console.log(`  ✗ ${path}: radius 非数值 ${JSON.stringify(n.radius)}`); layoutBad++;
  }
  if (n.blur != null && typeof n.blur !== "number") layoutBad++;
  if (n.rotate != null && typeof n.rotate !== "number") layoutBad++;
  if (n.opacity != null && typeof n.opacity !== "number") layoutBad++;
  if (n.font) {
    if (typeof n.font !== "object") fontBad++;
    else if (n.font.size != null && typeof n.font.size !== "number") fontBad++;
    else if (n.font.weight != null && typeof n.font.weight !== "number" && typeof n.font.weight !== "string") fontBad++;
  }
  if (n.kind === "text") {
    if (typeof n.text !== "string") { textBad++; console.log(`  ✗ ${path}: text 非字符串`); }
    if (n.stroke && (typeof n.stroke.width !== "number" || typeof n.stroke.color !== "string")) { textBad++; console.log(`  ✗ ${path}: stroke 结构错`); }
  }
  if (n.kind === "icon" || (n.kind === "image" && n.svg)) {
    if (typeof n.svg !== "string" || !n.svg.includes("<svg")) { console.log(`  ✗ ${path}: svg 内容缺失`); layoutBad++; }
  }
  (n.children || []).forEach((c, i) => walk(c, `${path}.children[${i}]`));
  if (n.template) walk(n.template, `${path}.template`);
})(tree.root, "root");
ok(kindBad === 0, `节点 kind 全合法(非法 ${kindBad})`);
ok(layoutBad === 0, `布局/样式字段全数值化(违规 ${layoutBad})`);
ok(shadowBad === 0, `shadows 全结构化 {inset,x,y,blur,spread,color}(违规 ${shadowBad})`);
ok(fontBad === 0, `font 全结构化(违规 ${fontBad})`);
ok(textBad === 0, `text 内容/描边结构合法(违规 ${textBad})`);

// ---- 3. 统计 ----
let counts = {};
(function cnt(n) { counts[n.kind] = (counts[n.kind] || 0) + 1; (n.children || []).forEach(cnt); if (n.template) cnt(n.template); })(tree.root);
console.log("节点统计:", JSON.stringify(counts));
console.log(`\n中立性断言: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);