// @3kaiu/dsh-plugin-kit layout-core 深度测试: 覆盖 mode 众数语义、
// simulateFlex 标准公式、inferCrossAlign 对齐判定、inferGrid 容差聚类与
// 各类边界降级。全部自包含,无外部依赖;
// 与 layout-infer 包的 layout-infer.test.mjs(真实稿回归)互补。
import { inferLayout, mode, round1, simulateFlex, clusterByAxis } from "../dist/index.js";

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${label}\n    期望: ${e}\n    实际: ${a}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

//#region mode: 众数语义
console.log("=== mode 众数语义 ===");
check("空数组 → null", mode([]), null);
check("单元素 → 该元素", mode([10]), 10);
check("唯一众数 → 众数值", mode([10, 10, 20]), 10);
check("两值平票 → null", mode([10, 20]), null);
check("双众数平票 → null", mode([10, 10, 20, 20]), null);
check("全不同 → null(不再返回第一个值)", mode([10, 20, 30]), null);
check("gap 序列 [20] → 20(单 gap 输出)", mode([20]), 20);
//#endregion

//#region simulateFlex: 标准 CSS flex 公式(相对 content box)
console.log("=== simulateFlex 标准公式 ===");
// row + center + 非对称 padding: 容器 100x50, padding [10, 15, 10, 5]
// content box 主轴 = 100 - 5 - 15 = 80; 两个子元素宽 20, gap 0
// 居中起点 = 5 + (80 - 40) / 2 = 25
const centerSim = simulateFlex(
  { width: 100, height: 50 },
  {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "start",
    gap: 0,
    padding: [10, 15, 10, 5],
  },
  [
    { x: 0, y: 0, width: 20, height: 20 },
    { x: 0, y: 0, width: 20, height: 20 },
  ],
);
check("center + 非对称 padding: 第一个子元素 x = 25", centerSim[0].x, 25);
check("center + 非对称 padding: 第二个子元素 x = 45", centerSim[1].x, 45);
// 交叉轴 center: content box 高 = 50 - 10 - 10 = 30; 子高 20 → y = 10 + (30-20)/2 = 15
const crossCenterSim = simulateFlex(
  { width: 100, height: 50 },
  { flexDirection: "row", alignItems: "center", gap: 0, padding: [10, 0, 10, 0] },
  [{ x: 0, y: 0, width: 20, height: 20 }],
);
check("交叉轴 center: y = 15", crossCenterSim[0].y, 15);
// 交叉轴 end: content box 高 = 30; 子高 20 → y = 10 + (30-20) = 20
const crossEndSim = simulateFlex(
  { width: 100, height: 50 },
  { flexDirection: "row", alignItems: "end", gap: 0, padding: [10, 0, 10, 0] },
  [{ x: 0, y: 0, width: 20, height: 20 }],
);
check("交叉轴 end: y = 20", crossEndSim[0].y, 20);
// 交叉轴 flex-end(旧别名)同样生效
const crossFlexEndSim = simulateFlex(
  { width: 100, height: 50 },
  { flexDirection: "column", alignItems: "flex-end", gap: 0, padding: [0, 10, 0, 10] },
  [{ x: 0, y: 0, width: 30, height: 20 }],
);
// column: cross = x; content box 宽 = 100-10-10 = 80; 子宽 30 → x = 10 + (80-30) = 60
check("column flex-end: x = 60", crossFlexEndSim[0].x, 60);
// space-between + padding: 3 子, content 主轴 80, 总宽 40 → slot = 20
const sbSim = simulateFlex(
  { width: 100, height: 50 },
  { flexDirection: "row", justifyContent: "space-between", alignItems: "start", gap: 0, padding: [0, 15, 0, 5] },
  [
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 20, height: 10 },
  ],
);
check("space-between: 第一个 x = 5", sbSim[0].x, 5);
check("space-between: 第二个 x = 35", sbSim[1].x, 35);
check("space-between: 第三个 x = 65", sbSim[2].x, 65);
//#endregion

//#region inferCrossAlign: 交叉轴对齐判定
console.log("=== 交叉轴对齐判定(经 inferLayout) ===");
// 顶部对齐、高度不同 → start(旧实现误判为 stretch)
const topAligned = inferLayout({
  container: { width: 300, height: 60 },
  children: [
    { id: "a", x: 0, y: 0, width: 40, height: 20 },
    { id: "b", x: 60, y: 0, width: 40, height: 40 },
  ],
});
check("顶部对齐不同高度 → alignItems start", topAligned.alignItems, "start");
// 底部对齐(交叉轴 end,row 中 y 底部一致,不重叠,可表达)→ flex + alignItems end
const bottomAligned = inferLayout({
  container: { width: 300, height: 60 },
  children: [
    { id: "a", x: 0, y: 40, width: 40, height: 20 },
    { id: "b", x: 60, y: 20, width: 40, height: 40 },
  ],
});
check("底部对齐(交叉轴)→ position flex", bottomAligned.position, "flex");
check("底部对齐(交叉轴)→ alignItems end", bottomAligned.alignItems, "end");
// 中心对齐 → center
const centerAligned = inferLayout({
  container: { width: 300, height: 60 },
  children: [
    { id: "a", x: 0, y: 20, width: 40, height: 20 },
    { id: "b", x: 60, y: 10, width: 40, height: 40 },
  ],
});
check("中心对齐 → alignItems center", centerAligned.alignItems, "center");
// 不再输出 stretch
check("任何场景都不输出 stretch", centerAligned.alignItems === "stretch" || bottomAligned.alignItems === "stretch", false);
// 主轴底部对齐(column, 不同高度贴同一底边 → 必然重叠)→ 视觉验证降级 absolute
const mainEndOverlap = inferLayout({
  container: { width: 100, height: 200 },
  children: [
    { id: "a", x: 10, y: 130, width: 60, height: 40 },
    { id: "b", x: 10, y: 90, width: 60, height: 80 },
  ],
});
check("主轴 end 重叠 → 降级 absolute", mainEndOverlap.position, "absolute");
//#endregion

//#region inferGrid: 容差聚类
console.log("=== 网格容差聚类 ===");
// 3x2 网格,坐标带 ±1px 抖动(旧 Math.round key 方案可能错分行)
const jitterGrid = [
  { id: "a", x: 0.4, y: 0.3, width: 40, height: 30 },
  { id: "b", x: 50.6, y: 0.8, width: 40, height: 30 },
  { id: "c", x: 0.2, y: 40.7, width: 40, height: 30 },
  { id: "d", x: 50.8, y: 40.2, width: 40, height: 30 },
  { id: "e", x: 0.6, y: 80.4, width: 40, height: 30 },
  { id: "f", x: 50.2, y: 80.6, width: 40, height: 30 },
];
const jitterResult = inferLayout({ container: { width: 120, height: 120 }, children: jitterGrid });
check("抖动网格 → flex wrap", jitterResult.position === "flex" && jitterResult.flexWrap === "wrap", true);
// 不规则布局 → 不应误判网格
const irregular = inferLayout({
  container: { width: 200, height: 200 },
  children: [
    { id: "a", x: 0, y: 0, width: 40, height: 40 },
    { id: "b", x: 60, y: 0, width: 80, height: 40 },
    { id: "c", x: 0, y: 60, width: 40, height: 100 },
  ],
});
check("不规则布局 → 非 wrap 网格", irregular.flexWrap, undefined);
// clusterByAxis 直接验证: 行间距 40 的两行,抖动 ±1 不合并
const clustered = clusterByAxis(
  [
    { y: 0.3, height: 30 },
    { y: 40.7, height: 30 },
  ],
  (k) => k.y,
  (k) => k.height,
  2,
);
check("clusterByAxis: 两行不合并", clustered.length, 2);
// 行间距 1px(<= tol)应合并
const merged = clusterByAxis(
  [
    { y: 0, height: 30 },
    { y: 30.5, height: 30 },
  ],
  (k) => k.y,
  (k) => k.height,
  2,
);
check("clusterByAxis: 间距 0.5 合并为一行", merged.length, 1);
//#endregion

//#region inferLayout 边界与降级
console.log("=== 边界与降级 ===");
// 空 children → absolute
check("空 children → absolute", inferLayout({ container: { width: 100, height: 100 }, children: [] }).position, "absolute");
// 单子节点水平居中 → flex column + alignItems center
const singleCentered = inferLayout({
  container: { width: 100, height: 100 },
  children: [{ id: "a", x: 30, y: 10, width: 40, height: 20 }],
});
check("单子水平居中 → flex", singleCentered.position, "flex");
check("单子水平居中 → alignItems center", singleCentered.alignItems, "center");
// 旋转节点 → absolute, 并标记 absolutes
const rotated = inferLayout({
  container: { width: 100, height: 100 },
  children: [
    { id: "sticker", x: 10, y: 10, width: 20, height: 20, rotation: 30 },
    { id: "plain", x: 10, y: 50, width: 20, height: 20 },
  ],
});
check("旋转节点 → absolute", rotated.position, "absolute");
check("旋转节点进入 absolutes", JSON.stringify(rotated.absolutes), JSON.stringify(["sticker"]));
// 子元素溢出容器(负 padding)→ absolute 降级
const overflow = inferLayout({
  container: { width: 100, height: 100 },
  children: [
    { id: "a", x: 0, y: 0, width: 40, height: 40 },
    { id: "b", x: -30, y: 0, width: 40, height: 40 },
  ],
});
check("负 padding 溢出 → absolute", overflow.position, "absolute");
// 两元素行 + 单一 gap → gap 输出该值(回归 mode 单元素行为)
const singleGap = inferLayout({
  container: { width: 200, height: 50 },
  children: [
    { id: "a", x: 10, y: 5, width: 40, height: 40 },
    { id: "b", x: 70, y: 5, width: 40, height: 40 },
  ],
});
check("两元素单 gap → gap = 20", singleGap.gap, 20);
// 三元素不等 gap → 无均匀 gap、无 space-between 信号,flex 无法表达 → 视觉验证降级 absolute
const noModeGap = inferLayout({
  container: { width: 300, height: 50 },
  children: [
    { id: "a", x: 10, y: 5, width: 40, height: 40 },
    { id: "b", x: 70, y: 5, width: 40, height: 40 },
    { id: "c", x: 150, y: 5, width: 40, height: 40 },
  ],
});
check("三元素不等 gap → 视觉验证降级 absolute", noModeGap.position, "absolute");
// round1 精度
check("round1 保留 1 位小数", round1(3.14159), 3.1);
//#endregion

if (failures > 0) {
  console.error(`\n${failures} 项失败 ✗`);
  process.exit(1);
}
console.log("\n深度测试全部通过 ✓");
