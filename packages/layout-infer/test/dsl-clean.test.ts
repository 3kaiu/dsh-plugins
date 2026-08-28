// 清洗算法回归测试(堆叠稿 → 标准 DSL)
// fixture: mg-stacked-sections.json — 拍平稿 30 个扁平 section(页面绝对坐标 + 文本)
// 验证 cleanToStandardDsl:
//   1) 输出标准 DSL 形态(语义容器树 / relativeX/Y / flexContainerInfo)
//   2) 清洗后重新渲染(absolute + flex), 每个节点的页面绝对 bbox 与输入一致(≤2.5px)
//   3) 语义命名: hero-background/status-bar/nav-bar/learn-card/sticker-card/
//      stats-row/content-tabs/tab-bar/tab-item-* 全部出现
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanToStandardDsl } from "@3kaiu/dsh-plugin-kit/dsl-clean";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mg-stacked-sections.json");
const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));

const sections = fx.nodes.map((n) => ({
  id: n.id,
  name: n.name,
  type: n.type,
  x: n.x,
  y: n.y,
  width: n.width,
  height: n.height,
  dsl: {
    styles: {},
    rowTexts: (n.texts || []).map((t) => ({ text: t, parentType: n.type, parentName: n.name })),
    nodes: [{
      type: n.type,
      id: n.id,
      name: n.name,
      layoutStyle: { width: n.width, height: n.height, relativeX: 0, relativeY: 0, ...(n.rotation != null ? { rotate: n.rotation } : {}) },
      ...(n._color != null ? { _color: n._color } : {}),
      ...(n.effect != null ? { effect: n.effect } : {}),
    }],
  },
}));

const result = cleanToStandardDsl({
  canvas: fx.meta.canvas,
  sections,
  rootMeta: { name: fx.meta.rootName, background: "#F6F7FB" },
});

const assert = (cond, msg) => {
  if (!cond) throw new Error("清洗失败: " + msg);
};

// ---- 1. 标准 DSL 形态 ----
assert(result.root.type === "FRAME", "根应为 FRAME");
assert(result.root.layoutStyle.width === 375 && result.root.layoutStyle.height === 812, "根尺寸应 375x812");
assert(result.root._color === "#F6F7FB", "根背景应来自 rootMeta");
assert(typeof result.styles === "object", "应有 styles 表");

// 每节点 layoutStyle 必须有相对坐标
const walk = (ns, depth) => {
  for (const n of ns) {
    assert(n.layoutStyle && typeof n.layoutStyle.relativeX === "number" && typeof n.layoutStyle.relativeY === "number", `节点 ${n.name} 缺相对坐标`);
    if (n.children) walk(n.children, depth + 1);
  }
};
walk(result.root.children, 0);

// ---- 2. 渲染几何一致性 ----
function render(node, parentOrigin, out, flexPlaced) {
  const x = flexPlaced ? parentOrigin.x : parentOrigin.x + node.layoutStyle.relativeX;
  const y = flexPlaced ? parentOrigin.y : parentOrigin.y + node.layoutStyle.relativeY;
  out.push({ id: node.id, x, y, width: node.layoutStyle.width, height: node.layoutStyle.height });
  const isFlex = node.flexContainerInfo && node.flexContainerInfo.flexDirection;
  if (!node.children || node.children.length === 0) return;
  if (isFlex) {
    const info = node.flexContainerInfo;
    const dir = info.flexDirection === "row" ? "row" : "column";
    const kids = node.children;
    // 技术中立格式: gap={row,column}, padding=[top,right,bottom,left]
    const gap = info.gap ? (typeof info.gap === "object" ? info.gap.row : 0) : 0;
    const pads = Array.isArray(info.padding) ? info.padding : [];
    const pT = pads[0] || 0;
    const pR = pads[1] != null ? pads[1] : pT;
    const pB = pads[2] != null ? pads[2] : pT;
    const pL = pads[3] != null ? pads[3] : pR;
    const mainSize = (dir === "row" ? node.layoutStyle.width : node.layoutStyle.height) - (dir === "row" ? pL + pR : pT + pB);
    const crossSize = (dir === "row" ? node.layoutStyle.height : node.layoutStyle.width) - (dir === "row" ? pT + pB : pL + pR);
    const sorted = [...kids].sort((a, b) => (dir === "row" ? a.layoutStyle.relativeX : a.layoutStyle.relativeY) - (dir === "row" ? b.layoutStyle.relativeX : b.layoutStyle.relativeY));
    let cursor = 0;
    const placements = [];
    if (info.justifyContent === "space-around") {
      const total = sorted.reduce((s, k) => s + (dir === "row" ? k.layoutStyle.width : k.layoutStyle.height), 0) + gap * (sorted.length - 1);
      const slot = (mainSize - total) / sorted.length;
      sorted.forEach((k) => {
        const sz = dir === "row" ? k.layoutStyle.width : k.layoutStyle.height;
        placements.push({ k, main: cursor + slot / 2 });
        cursor += sz + gap + slot;
      });
    } else if (info.justifyContent === "space-between") {
      const total = sorted.reduce((s, k) => s + (dir === "row" ? k.layoutStyle.width : k.layoutStyle.height), 0);
      const slot = (mainSize - total) / Math.max(1, sorted.length - 1);
      sorted.forEach((k) => {
        placements.push({ k, main: cursor });
        cursor += (dir === "row" ? k.layoutStyle.width : k.layoutStyle.height) + slot;
      });
    } else {
      sorted.forEach((k) => {
        placements.push({ k, main: cursor });
        cursor += (dir === "row" ? k.layoutStyle.width : k.layoutStyle.height) + gap;
      });
      if (info.justifyContent === "center" || info.justifyContent === "flex-end") {
        const total = sorted.reduce((s, k) => s + (dir === "row" ? k.layoutStyle.width : k.layoutStyle.height), 0) + gap * (sorted.length - 1);
        const offset = info.justifyContent === "center" ? (mainSize - total) / 2 : mainSize - total;
        for (const p of placements) p.main += offset;
      }
    }
    for (const { k, main } of placements) {
      let cross = 0;
      const align = info.alignItems || "start";
      if (align === "center") cross = (crossSize - (dir === "row" ? k.layoutStyle.height : k.layoutStyle.width)) / 2;
      else if (align === "end" || align === "flex-end") cross = crossSize - (dir === "row" ? k.layoutStyle.height : k.layoutStyle.width);
      const childOrigin = dir === "row" ? { x: x + pL + main, y: y + pT + cross } : { x: x + pL + cross, y: y + pT + main };
      render(k, childOrigin, out, true);
    }
  } else {
    for (const k of node.children) render(k, { x, y }, out, false);
  }
}

const leaves = [];
render(result.root, { x: 0, y: 0 }, leaves, false);
const leafById = new Map(leaves.map((l) => [l.id, l]));
const TOL = 2.5;
let maxDelta = 0;
for (const n of fx.nodes) {
  const l = leafById.get(n.id);
  assert(l, `${n.name}(${n.id}) 未渲染`);
  maxDelta = Math.max(maxDelta, Math.abs(l.x - n.x), Math.abs(l.y - n.y), Math.abs(l.width - n.width), Math.abs(l.height - n.height));
  assert(Math.abs(l.x - n.x) <= TOL && Math.abs(l.y - n.y) <= TOL, `${n.name}: y 偏移 ${Math.abs(l.y - n.y)}px (期望 ${n.y}, 实际 ${l.y.toFixed(1)})`);
  assert(Math.abs(l.width - n.width) <= TOL && Math.abs(l.height - n.height) <= TOL, `${n.name}: 尺寸偏移`);
}
assert(maxDelta <= TOL, "最大偏差 " + maxDelta + "px 超过容差");

// ---- 3. 语义命名 ----
const names = new Set();
const walkNames = (ns) => {
  for (const n of ns) {
    names.add(n.name);
    if (n.children) walkNames(n.children);
  }
};
walkNames(result.root.children);
const mustHave = ["hero-background", "status-bar", "nav-bar", "learn-card", "sticker-card", "stats-row", "content-tabs", "tab-bar"];
for (const m of mustHave) assert([...names].some((n) => n.startsWith(m)), "缺少语义容器 " + m + ", 实际: " + [...names].join(","));
const wantTabs = ["tab-item-首页", "tab-item-对话", "tab-item-学习", "tab-item-场景", "tab-item-我的"];
for (const t of wantTabs) assert([...names].includes(t), "缺少 " + t);

// ---- 4. 统计 ----
assert(result.stats.total === 30, "total 应 30");
assert(result.stats.background === 1, "background 应 1");
assert(result.stats.offCanvas === 1, "offCanvas 应 1");

console.log("清洗算法回归 ✓ 几何一致(maxDelta=" + maxDelta.toFixed(2) + "px) 语义命名 ✓ stats=" + JSON.stringify(result.stats));