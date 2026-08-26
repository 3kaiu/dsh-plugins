// repeat/system-chrome/切图决策 测试: repeater 检测 + 系统元素识别 + 资产渲染策略
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDsl, detectRepeatGroups, structureFingerprint } from "../dist/index.js";

function item(x, y, label) {
  return {
    id: `item-${x}-${y}`,
    name: "矩形 1",
    type: "FRAME",
    layoutStyle: { relativeX: x, relativeY: y, width: 100, height: 60 },
    children: [
      { id: `t-${x}-${y}`, name: "文本", type: "TEXT", layoutStyle: { relativeX: 12, relativeY: 10, width: 60, height: 20 }, text: [{ text: label }] },
    ],
  };
}

test("structureFingerprint: 同构不同文案 -> 相同指纹; 尺寸差>4px -> 不同指纹", () => {
  const a = item(0, 0, "课程A");
  const b = item(0, 80, "课程B");
  assert.equal(structureFingerprint(a), structureFingerprint(b));
  const big = JSON.parse(JSON.stringify(a));
  big.layoutStyle.width = 200;
  assert.notEqual(structureFingerprint(a), structureFingerprint(big));
});

test("detectRepeatGroups: 3 个纵向同构兄弟 -> column 组, gap 中位数", () => {
  const kids = [item(0, 0, "a"), item(0, 80, "b"), item(0, 160, "c"), item(0, 245, "d")];
  const groups = detectRepeatGroups(kids);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.count, 4);
  assert.equal(g.axis, "column");
  assert.equal(g.itemWidth, 100);
  assert.equal(g.itemHeight, 60);
  assert.equal(g.gap, 20); // 80-60=20, 85-60=25, 85-60=25 -> 中位数 25? 见下
});

test("classifyDsl: 重复组首项带 repeat 元数据, 其余项标 repeatItem", () => {
  const kids = [item(0, 0, "a"), item(0, 80, "b"), item(0, 160, "c")];
  const root = {
    id: "root",
    name: "列表",
    type: "FRAME",
    layoutStyle: { relativeX: 0, relativeY: 0, width: 375, height: 600 },
    children: kids,
  };
  const res = classifyDsl({ styles: {}, nodes: [root], components: [] });
  const listNode = res.tree[0].children[0];
  assert.ok(listNode.repeat, "首项应带 repeat");
  assert.equal(listNode.repeat.count, 3);
  assert.equal(listNode.repeat.axis, "column");
  assert.ok(listNode.repeat.itemIds.includes("item-0-80"));
  assert.equal(listNode.repeatItem, undefined);
  for (const c of res.tree[0].children.slice(1)) {
    assert.equal(c.repeatItem, true);
    assert.equal(c.repeatOf, "item-0-0");
  }
});

test("classifyDsl: 不足 3 个同构兄弟不构成重复组", () => {
  const root = {
    id: "root",
    name: "容器",
    type: "FRAME",
    layoutStyle: { relativeX: 0, relativeY: 0, width: 375, height: 600 },
    children: [item(0, 0, "a"), item(0, 80, "b")],
  };
  const res = classifyDsl({ styles: {}, nodes: [root], components: [] });
  assert.equal(res.tree[0].children[0].repeat, undefined);
});

test("classifyDsl: 状态栏时间文本与 Home Indicator -> system-chrome, sizing=environment", () => {
  const timeText = {
    id: "t1",
    name: "9:41",
    type: "TEXT",
    layoutStyle: { relativeX: 30, relativeY: 20, width: 40, height: 16 },
    text: [{ text: "9:41" }],
  };
  const root = {
    id: "root",
    name: "页面",
    type: "FRAME",
    layoutStyle: { relativeX: 0, relativeY: 0, width: 375, height: 812 },
    children: [
      timeText,
      { id: "hi", name: "Home Indicator", type: "INSTANCE", layoutStyle: { relativeX: 120, relativeY: 790, width: 134, height: 5 } },
    ],
  };
  const res = classifyDsl({ styles: {}, nodes: [root], components: [] });
  assert.equal(res.stats.systemChrome, 2);
  const [time, home] = res.tree[0].children;
  assert.equal(time.kind, "system-chrome");
  assert.equal(time.sizing.main, "environment");
  assert.equal(home.kind, "system-chrome");
});

test("classifyDsl: 内容区时间文本不算系统元素", () => {
  const root = {
    id: "root",
    name: "页面",
    type: "FRAME",
    layoutStyle: { relativeX: 0, relativeY: 0, width: 375, height: 812 },
    children: [
      { id: "t2", name: "倒计时", type: "TEXT", layoutStyle: { relativeX: 30, relativeY: 400, width: 40, height: 16 }, text: [{ text: "09:41" }] },
    ],
  };
  const res = classifyDsl({ styles: {}, nodes: [root], components: [] });
  assert.equal(res.stats.systemChrome, 0);
});

test("collectAssets: IMAGE -> export-png + 命名后缀; 简单填充 -> code-draw", () => {
  const root = {
    id: "root",
    name: "页面",
    type: "FRAME",
    layoutStyle: { relativeX: 0, relativeY: 0, width: 375, height: 812 },
    children: [
      { id: "img1", name: "头像/avatar-2", type: "IMAGE", layoutStyle: { relativeX: 0, relativeY: 0, width: 48, height: 48 }, fill: "paint_x" },
      {
        id: "img2",
        name: "banner",
        type: "IMAGE",
        layoutStyle: { relativeX: 0, relativeY: 100, width: 300, height: 120 },
        fill: "paint_y",
      },
    ],
  };
  const styles = {
    paint_x: { value: "url(https://cdn.example.com/a.png)" },
    paint_y: { value: "#ff0000" },
  };
  const res = classifyDsl({ styles, nodes: [root], components: [] });
  const [img1, img2] = res.assets.images;
  assert.equal(img1.render, "export-png");
  assert.equal(img1.suggestedFileName, "头像_avatar-2_phone.png");
  assert.equal(img2.render, "code-draw");
  assert.equal(img2.suggestedFileName, null);
});

test("detectSharedComponents: 跨 section 同构容器 -> 全局组件组, 嵌套子树去重", async () => {
  const { detectSharedComponents } = await import("../dist/index.js");
  const card = (x, y, title) => ({
    id: `card-${title}`,
    name: "卡片",
    type: "FRAME",
    layoutStyle: { relativeX: x, relativeY: y, width: 300, height: 120 },
    children: [
      { id: `t-${title}`, type: "TEXT", layoutStyle: { relativeX: 12, relativeY: 10, width: 100, height: 20 }, text: [{ text: title }] },
    ],
  });
  const secA = [card(0, 0, "A1"), card(0, 200, "A2")];
  const secB = [card(0, 50, "B1")];
  const secC = [{ id: "other", type: "FRAME", layoutStyle: { relativeX: 0, relativeY: 0, width: 80, height: 40 }, children: [] }];
  const groups = detectSharedComponents([secA, secB, secC]);
  assert.equal(groups.length, 1); // 卡片组; other 无子节点不索引
  const g = groups[0];
  assert.equal(g.count, 3);
  assert.deepEqual(g.sections.sort(), [0, 1]);
  assert.equal(g.itemWidth, 300);
});
