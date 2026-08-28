// classify.js 测试: 直读优先的还原决策分类
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDsl, kindOf, sizingOf, positionOf, svgOf } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREFIX = join(__dirname, "..", "fixtures", "mg-magic-sample.json");

function dsl(nodes, styles = {}) {
  return { styles, nodes, components: [] };
}

test("kind: TEXT -> text, PATH -> icon, 有子节点 -> container", () => {
  const res = kindOf({ type: "TEXT", text: [{ text: "hi" }] }, {});
  assert.equal(res.kind, "text");
  assert.equal(res.confidence, 1);

  const icon = kindOf({ type: "PATH", path: [{ data: "M0 0" }] }, {});
  assert.equal(icon.kind, "icon");
  assert.equal(icon.confidence, 1);

  const cont = kindOf({ type: "FRAME", children: [{ type: "TEXT" }] }, {});
  assert.equal(cont.kind, "container");
  assert.equal(cont.confidence, 1);
});

test("kind: image fill -> image(需切图); 无子无填充 -> shape/spacer", () => {
  const styles = { paint_img: { value: ["url(https://x/a.png)"] } };
  const img = kindOf({ type: "FRAME", fill: "paint_img" }, styles);
  assert.equal(img.kind, "image");
  assert.equal(img.confidence, 1);

  const shape = kindOf({ type: "FRAME", fill: "paint_a" }, { paint_a: { value: ["#fff"] } });
  assert.equal(shape.kind, "shape");

  const spacer = kindOf({ type: "FRAME" }, {});
  assert.equal(spacer.kind, "spacer");
});

test("kind: 命名兜底 icon/image", () => {
  assert.equal(kindOf({ type: "FRAME", name: "brand-icon" }, {}).kind, "icon");
  assert.equal(kindOf({ type: "FRAME", name: "avatar" }, {}).kind, "image");
});

test("sizing: flexContainerInfo.mainSizing/crossSizing 直读, confidence=1", () => {
  const s = sizingOf({ type: "FRAME", flexContainerInfo: { mainSizing: "auto", crossSizing: "fixed" } });
  assert.equal(s.main, "auto");
  assert.equal(s.cross, "fixed");
  assert.equal(s.confidence, 1);

  const f = sizingOf({ type: "FRAME", flexContainerInfo: { mainSizing: "fixed", crossSizing: "auto" } });
  assert.equal(f.main, "fixed");
  assert.equal(f.cross, "auto");
});

test("sizing: textMode auto-height -> main auto; single-line -> fixed", () => {
  assert.equal(sizingOf({ type: "TEXT", textMode: "auto-height" }).main, "auto");
  assert.equal(sizingOf({ type: "TEXT", textMode: "single-line" }).main, "fixed");
});

test("sizing: 无原生信号 -> null + 低置信度", () => {
  const s = sizingOf({ type: "FRAME" });
  assert.equal(s.main, null);
  assert.equal(s.confidence, 0.35);
});

test("position: rotation -> absolute; 父 absolute 上下文继承", () => {
  const a = positionOf({ layoutStyle: { rotate: 90 } }, false);
  assert.equal(a.position, "absolute");
  assert.equal(a.confidence, 1);

  const b = positionOf({ layoutStyle: {} }, true);
  assert.equal(b.position, "absolute");

  const c = positionOf({ layoutStyle: {} }, false);
  assert.equal(c.position, "flow");
});

test("classifyDsl: 真实 MasterGo DSL 样本(70 节点)跑通且统计自洽", () => {
  const fixture = JSON.parse(readFileSync(PREFIX, "utf8"));
  const { stats, tree, assets } = classifyDsl(fixture);

  assert.equal(stats.total, 70);
  assert.equal(stats.containers + stats.texts + stats.icons + stats.images + stats.shapes + stats.spacers, 70);
  assert.equal(stats.absolute + stats.flow, 70);
  assert.equal(stats.autoMain + stats.fixedMain <= 70, true);
  // 真实稿: PATH 图标应进 inlineSvg(前 70 节点含 3 个 PATH)
  assert.ok(stats.icons >= 1, `icons=${stats.icons}`);
  assert.ok(assets.inlineSvg.length >= 1, `inlineSvg=${assets.inlineSvg.length}`);
  assert.ok(assets.texts.length >= 5, `texts=${assets.texts.length}`);
  // 原生 flex 容器不应被几何反推误标为 absolute
  assert.ok(stats.absolute < 10, `absolute=${stats.absolute}`);
  assert.ok(tree[0].kind === "container");
  assert.ok(tree[0].confidence > 0 && tree[0].confidence <= 1);
});

test("classifyDsl: 纯几何节点树(无 styles)不抛错, 置信度降低", () => {
  const geo = [
    {
      id: "a",
      name: "row",
      type: "FRAME",
      layoutStyle: { width: 200, height: 50, relativeX: 0, relativeY: 0 },
      children: [
        { id: "a1", name: "b1", type: "FRAME", layoutStyle: { width: 50, height: 50, relativeX: 0, relativeY: 0 }, fill: "paint_x" },
        { id: "a2", name: "b2", type: "FRAME", layoutStyle: { width: 50, height: 50, relativeX: 100, relativeY: 0 }, fill: "paint_y" },
      ],
    },
  ];
  const { stats, tree, assets } = classifyDsl(dsl(geo));
  assert.equal(stats.total, 3);
  assert.equal(tree[0].sizing, null); // 无 flexContainerInfo -> sizing null
  assert.equal(tree[0].spacing.gap, 50); // 几何反推等间距 -> gap 50
  assert.equal(assets.inlineSvg.length, 0);
  assert.equal(assets.images.length, 0);
});

test("classifyDsl: 空输入安全", () => {
  const r1 = classifyDsl(null);
  assert.equal(r1.stats.total, 0);
  const r2 = classifyDsl({});
  assert.equal(r2.stats.total, 0);
});

test("svgOf: PATH + paint 引用 -> 可内联 SVG 字符串", () => {
  const styles = { paint_icon: { value: ["#2563EB"] } };
  const svg = svgOf(
    { type: "PATH", name: "icon", layoutStyle: { width: 10.5, height: 12 }, path: [{ fill: "paint_icon", data: "M5.99 0C6.41 0 6.75 0.33 6.75 0.75Z" }] },
    styles,
  );
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 10.5 12"/);
  assert.match(svg, /<path d="M5.99 0/);
  assert.match(svg, /fill="#2563EB"/);
});

test("classifyDsl: 低置信度容器进 unresolved, assets.inlineSvg 含 svg 字符串", () => {
  const geo = [
    {
      id: "root",
      name: "root",
      type: "FRAME",
      layoutStyle: { width: 200, height: 200, relativeX: 0, relativeY: 0 },
      children: [
        { id: "i1", name: "icon", type: "PATH", layoutStyle: { width: 12, height: 12, relativeX: 0, relativeY: 0 }, path: [{ fill: "paint_a", data: "M0 0h1v1z" }] },
        { id: "c1", name: "容器", type: "FRAME", layoutStyle: { width: 100, height: 50, relativeX: 20, relativeY: 0 }, children: [] },
      ],
    },
  ];
  const { stats, assets, unresolved } = classifyDsl({ styles: { paint_a: { value: ["#000"] } }, nodes: geo });
  assert.equal(assets.inlineSvg.length, 1);
  assert.match(assets.inlineSvg[0].svg, /<svg /);
  assert.equal(unresolved.length, 1); // 仅 root 是无约束信号的容器(c1 无子无填充 -> spacer,不参与 sizing)
  assert.equal(unresolved[0].name, "root");
  assert.equal(stats.total, 3);
});

test("spacingOf: 直读 flexContainerInfo gap/padding/justifyContent 优先于几何反推", async () => {
  const { spacingOf } = await import("../dist/index.js");
  const node = {
    type: "FRAME",
    layoutStyle: { width: 580, height: 329, relativeX: 0, relativeY: 738 },
    flexContainerInfo: { flexDirection: "column", alignItems: "center", mainSizing: "auto", crossSizing: "fixed", gap: "24px 24px", padding: "40px" },
    children: [
      { id: "a", layoutStyle: { width: 500, height: 177, relativeX: 40, relativeY: 112 } },
    ],
  };
  const s = spacingOf(node);
  assert.equal(s.gap, "24px 24px");
  assert.equal(s.gapConfidence, 1);
  assert.equal(s.padding, "40px");
  assert.equal(s.paddingConfidence, 1);
  assert.equal(s.alignItems, "center");
  assert.equal(s.position, "flow");
  assert.equal(s.positionConfidence, 1);
});
