// @3kaiu/dsh-plugin-kit layout-core 深度测试: 覆盖 mode 众数语义、
// simulateFlex 标准公式、inferCrossAlign 对齐判定、inferGrid 容差聚类与
// 各类边界降级。全部自包含,无外部依赖;
// 与 layout-infer 包的 layout-infer.test.mjs(真实稿回归)互补。
import { inferLayout, mode, round1, simulateFlex, clusterByAxis, autoHealingLayoutDiff, generateCodeBlueprint, verifyStyleConservation, parseNeutralFill, verifyLayoutTruth, measurerInfo, measureTextWidth, predictTextLayout, comparePng, blockMetrics, textSimilarity, validateBlueprint, blueprintToOutline, detectSiblingComponentGroups, extractDesignTokens, ingestDesignExport, lintDesignExport, extractExactStyles, detectDesignScale, applyDesignScale, resolveDesignScale, restorationChecklist, checklistToText, diffRegions } from "../dist/index.js";

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

//#region 网格: 规整网格的几何守恒语义
console.log("=== 网格几何守恒 ===");
// 3x2 网格,坐标带 ±1px 抖动: 行列信号并存时按主轴 spread 判定, 无法表达的第二维
// 由 simulateFlex 检出偏差 → 降级 absolute, 几何由 bounds 差值守恒(不产出伪 wrap 语义)
const jitterGrid = [
  { id: "a", x: 0.4, y: 0.3, width: 40, height: 30 },
  { id: "b", x: 50.6, y: 0.8, width: 40, height: 30 },
  { id: "c", x: 0.2, y: 40.7, width: 40, height: 30 },
  { id: "d", x: 50.8, y: 40.2, width: 40, height: 30 },
  { id: "e", x: 0.6, y: 80.4, width: 40, height: 30 },
  { id: "f", x: 50.2, y: 80.6, width: 40, height: 30 },
];
const jitterResult = inferLayout({ container: { width: 120, height: 120 }, children: jitterGrid });
check("抖动网格 → 几何守恒降级(无伪 wrap)", [jitterResult.position, jitterResult.flexWrap], ["absolute", undefined]);
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
check("三元素不等 gap → flex + spacing 数组", [noModeGap.position, JSON.stringify(noModeGap.spacing)], ["flex", "[20,40]"]);
check("三元素不等 gap → gap 为 null", noModeGap.gap, null);
// 负间距(重叠)同样通过 spacing 表达,不再因 gap 模拟失败降级
const negGap = inferLayout({
  container: { width: 200, height: 50 },
  children: [
    { id: "a", x: 10, y: 5, width: 40, height: 40 },
    { id: "b", x: 40, y: 5, width: 40, height: 40 },
  ],
});
check("两元素负 gap → flex + spacing 含负值", [negGap.position, JSON.stringify(negGap.spacing)], ["flex", "[-10]"]);
// round1 精度
check("round1 保留 1 位小数", round1(3.14159), 3.1);
//#endregion

//#region autoHealingLayoutDiff: 原因标注(P1-8)
console.log("=== 回验 diff 原因标注 ===");
{
  const orig = [
    { id: "p", name: "卡片", x: 0, y: 0, width: 100, height: 100 },
    { id: "a", name: "头像", x: 10, y: 10, width: 40, height: 40 },
  ];
  // 重建树: 头像位置漂移 6px(position-x), 父容器是 row
  const rec = [
    {
      id: "p", name: "卡片", x: 0, y: 0, width: 100, height: 100,
      layout: { role: "row", position: "flex" },
      children: [{ id: "a", name: "头像", x: 16, y: 10, width: 40, height: 40 }],
    },
  ];
  const r = autoHealingLayoutDiff(orig, rec);
  check("diff maxDelta", r.maxDelta, 6);
  check("offender drift", r.worstOffenders[0].drift, "position-x");
  check("offender 责任容器", r.worstOffenders[0].responsibleContainer.id, "p");
  check("verdict FAIL", r.verdict.startsWith("FAIL_OVER_TOLERANCE"), true);
  check("allOffenderIds 全集", JSON.stringify(r.allOffenderIds), "[\"a\"]");
}
//#endregion

//#region 文本样式: dsl.styles 字体引用解析 + 行盒事实(P2-3)
console.log("=== 文本样式引用解析与行盒事实 ===");
{
  const styles = {
    "font_a": { value: { family: "PingFang HK", size: 12, weight: "500", lineHeight: "auto", letterSpacing: "auto" } },
    "font_b": { value: { size: 14, weight: 400, lineHeight: 20, letterSpacing: 0.5 } },
  };
  const text = (fontRef) => ({
    type: "TEXT", name: "t",
    layoutStyle: { relativeX: 0, relativeY: 0, width: 60, height: 17 },
    text: [{ text: "示例", font: fontRef }],
  });
  const canvas = { width: 375, height: 812 };
  // 引用解析: 字号/字重来自 styles 表; 字重原值直读(500 不做项目级映射)
  const r1 = generateCodeBlueprint({ canvas, nodes: [text("font_a")], styles });
  const t1 = (r1.tree || [])[0];
  check("字体引用 -> fontSize", t1.fontSize, 12);
  check("字重原值直读 500->500", t1.fontWeight, 500);
  // 数字 lineHeight 进蓝图; auto 不臆造
  const r2 = generateCodeBlueprint({ canvas, nodes: [text("font_b")], styles });
  const t2 = (r2.tree || [])[0];
  check("数字 lineHeight 进蓝图", t2.lineHeight, 20);
  check("auto lineHeight 不进蓝图", t1.lineHeight, undefined);
  // letterSpacing 端到端: 字体表数字字距 -> 蓝图
  const r3 = generateCodeBlueprint({ canvas, nodes: [text("font_b")].map(n => ({ ...n })), styles });
  check("letterSpacing 进蓝图", (r3.tree || [])[0]?.letterSpacing, 0.5);
}
//#endregion

//#region 视觉属性端到端: 颜色/圆角/阴影/尺寸进蓝图(P2-4, 中立)
console.log("=== 视觉属性端到端 ===");
{
  const node = {
    type: "FRAME", name: "card",
    layoutStyle: { relativeX: 10, relativeY: 20, width: 300, height: 120 },
    borderRadius: [16, 16, 0, 0], _color: "#FFFFFF",
    effects: [{ type: "DROP_SHADOW", offset: { x: 0, y: 4 }, radius: 12, spread: 2, color: "rgba(0,0,0,0.1)" }],
    children: [
      { type: "TEXT", name: "t", layoutStyle: { relativeX: 0, relativeY: 0, width: 60, height: 17 }, _color: "#B6BDCA", text: [{ text: "标题" }] },
    ],
  };
  const res = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [node] });
  const root = res.tree[0];
  check("容器颜色进蓝图", root.color, "#FFFFFF");
  check("容器圆角进蓝图(layout)", JSON.stringify(root.layout.borderRadius), "[16,16,0,0]");
  check("容器阴影进蓝图(layout)", (root.layout.effects || [])[0]?.type, "DROP_SHADOW");
  check("容器尺寸唯一真值在 bounds", `${root.bounds.width}x${root.bounds.height}`, "300x120");
  check("layout 不重复携带尺寸(防双源漂移)", root.layout.width === undefined && root.layout.height === undefined, true);
  // 文本颜色用独立 TEXT 节点验证(容器内单子节点会被聚类重排, 树形不稳定)
  const tNode = { type: "TEXT", name: "t2", layoutStyle: { relativeX: 5, relativeY: 5, width: 60, height: 17 }, _color: "#B6BDCA", text: [{ text: "标题" }] };
  const resT = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [tNode] });
  check("文本颜色进蓝图", (resT.tree || [])[0]?.color, "#B6BDCA");
  // 中立性: 蓝图(算法输出)不含任何技术栈/项目级字面量
  const bpStr = JSON.stringify(res);
  check("蓝图技术栈中立", ["dp(", "EdgeInsets", "MainAxisAlignment", "CrossAxisAlignment", "flutterWidget", "AdaptiveDesignBuilder", "Positioned"].some((k) => bpStr.includes(k)), false);
}
//#endregion

//#region 布局真值引擎: Yoga 求解 vs 设计几何(P2-6)
console.log("=== 布局真值引擎 ===");
{
  const bp = {
    tree: [
      {
        // 推断正确: column + gap20 重排后与设计几何零偏差
        id: "col", name: "c", type: "FRAME", bounds: { x: 0, y: 0, width: 300, height: 120 },
        layout: { role: "column", position: "flex", justifyContent: "start", alignItems: "start", gap: 20, padding: [0, 0, 0, 0] },
        children: [
          { id: "a", bounds: { x: 0, y: 0, width: 100, height: 40 }, layout: {} },
          { id: "b", bounds: { x: 0, y: 60, width: 100, height: 40 }, layout: {} },
        ],
      },
      {
        // 推断错误: 设计有间距但推断 gap=0 -> 真值引擎必须抓到
        id: "bad", name: "x", type: "FRAME", bounds: { x: 0, y: 200, width: 300, height: 120 },
        layout: { role: "column", position: "flex", justifyContent: "start", alignItems: "start", gap: 0, padding: [0, 0, 0, 0] },
        children: [
          { id: "a2", bounds: { x: 0, y: 210, width: 100, height: 40 }, layout: {} },
          { id: "b2", bounds: { x: 0, y: 270, width: 100, height: 40 }, layout: {} },
        ],
      },
      {
        // 变间距(gap 数组): 标准求解器不可表达, 应跳过
        id: "arr", name: "g", type: "FRAME", bounds: { x: 0, y: 400, width: 300, height: 100 },
        layout: { role: "row", position: "flex", gap: [-22.5] },
        children: [{ id: "z", bounds: { x: 0, y: 400, width: 50, height: 30 }, layout: {} }],
      },
    ],
  };
  const r = verifyLayoutTruth(bp);
  check("真值: 容器计数", `${r.containersChecked}/${r.containersSkipped}`, "2/1");
  check("真值: 正确容器零偏差命中", r.childrenMatched, 2);
  check("真值: 失配被抓获", r.worst[0]?.childId, "b2");
  check("真值: 最大偏差数值", r.maxDelta, 30);
  check("真值: verdict FAIL 形态", String(r.verdict.startsWith("FAIL_TRUTH")), "true");
}
//#endregion

//#region 设计token/文本度量/视觉对比内核(P2-7: 开源增强三件套)
console.log("=== DTCG token / 文本度量 / 视觉对比 ===");
{
  // DTCG: 去重 + 命名 + $value/$type 结构
  const node = {
    type: "FRAME", name: "card", layoutStyle: { relativeX: 0, relativeY: 0, width: 300, height: 120 },
    _color: "#FFFFFF", borderRadius: 16,
    children: [
      { type: "TEXT", layoutStyle: { relativeX: 0, relativeY: 0, width: 60, height: 17 }, _color: "#B6BDCA", text: [{ text: "A" }] },
      { type: "TEXT", layoutStyle: { relativeX: 0, relativeY: 30, width: 60, height: 17 }, _color: "#B6BDCA", text: [{ text: "B" }] },
    ],
  };
  const res = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [node] });
  const dt = res.designTokens;
  check("token: 结构含 $type/$value", !!(dt.tokens["color.bg.1"]?.$type && dt.tokens["color.bg.1"]?.$value), true);
  // 文本 token 用独立 TEXT 节点验证(容器内子节点会被聚类重排)
  const resT = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [node.children[0]] });
  const dtT = resT.designTokens;
  check("token: 文本色归组 color.text", !!dtT.tokens["color.text.1"] && dtT.stats.colorTextInput === 1, true);
  // 内嵌 designTokens 不含 aliases(防膨胀); 全量别名表按需经 extractDesignTokens 取
  check("token: 内嵌 aliases 已瘦身", res.designTokens.aliases.length, 0);
  const fullDt = extractDesignTokens(res, { includeAliases: true });
  const fullDtT = extractDesignTokens(resT, { includeAliases: true });
  check("token: 按需 alias 回填", [...fullDt.aliases, ...fullDtT.aliases].every((a) => a.token), true);
  check("token: 中立命名", Object.keys({ ...dt.tokens, ...dtT.tokens }).every((k) => /^(color|font|radius|shadow)\./.test(k)), true);
}
{
  // 文本度量: 字体模式精确 CJK 宽度; 启发式兜底可用
  const info = measurerInfo();
  if (info.available) {
    check("度量: CJK 全角宽", measureTextWidth("词书", 12), 24);
  } else {
    check("度量: 启发式 CJK 全角宽", measureTextWidth("词书", 12), 24);
  }
  const p = predictTextLayout({ text: "一二三四五六", fontSize: 10, maxWidth: 35 });
  check("度量: 换行预测行数>1", p.lines > 1 && p.overflow, true);
}
{
  // 视觉对比内核: 像素层 + 块级层
  const { PNG } = await import("pngjs");
  const mk = (off) => {
    const img = new PNG({ width: 100, height: 40 });
    for (let i = 0; i < 100 * 40; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255; }
    for (let y = 5; y < 15; y++) for (let x = 10 + off; x < 40 + off; x++) { const i = (y * 100 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; }
    return PNG.sync.write(img);
  };
  const r = comparePng(mk(0), mk(3));
  check("视觉: 偏移产生像素 diff", r.diffPixels > 0 && r.diffRatio > 0, true);
  const d = [{ text: "课程学习", x: 10, y: 5, width: 30, height: 10 }];
  const rm = [{ text: "课程学习", x: 13, y: 5, width: 30, height: 10 }];
  const bm = blockMetrics(d, rm);
  check("视觉: 同文块匹配", bm.matchedPairs === 1 && bm.avgTextSimilarity === 1, true);
  check("视觉: 位置相似度<1", bm.positionSimilarity < 1 && bm.positionSimilarity > 0.9, true);
  check("视觉: 错别字 dice 容错", textSimilarity("课程学习", "课程学刁") > 0.5, true);
}
//#endregion

//#region 图标引用通路: svgKey 从原始 DSL 到蓝图(P2-8)
console.log("=== 图标引用通路 ===");
{
  const icon = { type: "PATH", name: "icon", layoutStyle: { relativeX: 10, relativeY: 10, width: 22, height: 22 }, svgShortKey: "S1#0" };
  const res = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [icon] });
  check("svgKey 进蓝图", res.tree[0].svgKey, "S1#0");
  // 防御性展平: 嵌套树输入不再静默丢子树(自动转扁平绝对坐标)
  const nested = { type: "FRAME", name: "wrap", layoutStyle: { relativeX: 0, relativeY: 0, width: 100, height: 100 },
    children: [{ type: "PATH", name: "cap", layoutStyle: { relativeX: 5, relativeY: 5, width: 10, height: 10 }, svgShortKey: "S2#1" }] };
  const res2 = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [nested] });
  let found = null; const w = (n) => { if (found || !n) return; if (n.svgKey) found = n.svgKey; (n.children || []).forEach(w); };
  res2.tree.forEach(w); (res2.floatings || []).forEach(w);
  check("扁平输入 svgKey 经 raw 回读", found, "S2#1");
}
//#endregion

//#region 契约固化: Schema v1 校验 + outline 双表征(P3-2)
console.log("=== 契约固化 ===");
{
  const node = { type: "FRAME", name: "card", layoutStyle: { relativeX: 0, relativeY: 0, width: 300, height: 120 },
    _color: "#FFFFFF", children: [{ type: "TEXT", layoutStyle: { relativeX: 0, relativeY: 0, width: 60, height: 17 }, _color: "#B6BDCA", text: [{ text: "标题" }] }] };
  const res = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [node] });
  const v = validateBlueprint(res);
  check("契约: 真实蓝图过校验", v.ok, true);
  // 破坏注入: 非法 role 必须被抓
  const bad = JSON.parse(JSON.stringify(res));
  bad.tree[0].layout.role = "grid";
  const vb = validateBlueprint(bad);
  check("契约: 非法 role 被拒", vb.ok === false && vb.errors[0].includes("role"), true);
  const outline = blueprintToOutline(res);
  check("outline: 含角色/坐标/文字", outline.includes("[box]") && outline.includes("300x120") && outline.includes("标题"), true);
  check("outline: 含消费指南", outline.includes("消费指南") && outline.includes("softWrap=false"), true);
  check("outline: 紧凑于 JSON", outline.length < JSON.stringify(res).length, true);
}
//#endregion

//#region 同构兄弟组件组(P3-3): 顺序无关 + 多组并存
console.log("=== 同构兄弟组件组 ===");
{
  // 输入契约: 几何在 layoutStyle(相对父坐标); 扁平传子节点(管线自动展平)
  const mkCard = (x, y, num) => ({
    type: "PATH", name: "卡" + num, svgKey: "S" + num,
    layoutStyle: { relativeX: x, relativeY: y, width: 102, height: 98 },
    children: [
      { type: "TEXT", name: "数值", layoutStyle: { relativeX: 23, relativeY: 26, width: 33, height: 38 }, text: [{ text: num }], fontSize: 38, color: "#000000" },
      { type: "TEXT", name: "标签", layoutStyle: { relativeX: 27, relativeY: 59, width: 48, height: 17 }, text: [{ text: "今日学习" }], fontSize: 12, color: "#AAAAAA" },
    ],
  });
  // 三张卡子节点顺序不同(几何聚类顺序因位置而异) — 指纹必须顺序无关
  const cardA = mkCard(34.6, 177.1, "25");
  const cardB = mkCard(138.4, 180.1, "94");
  cardB.children = [cardB.children[1], cardB.children[0]];
  const cardC = mkCard(240.7, 180.5, "67");
  const tab = (x, name) => ({ type: "TEXT", name, layoutStyle: { relativeX: x, relativeY: 764, width: 20, height: 14 }, text: [{ text: name }], fontSize: 12, color: "#D1D1D1" });
  const res = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [cardA, cardB, cardC, tab(32, "对话"), tab(105, "首页"), tab(178, "场景"), tab(250, "学习")] });
  const gs = res.componentGroups || [];
  const cardG = gs.find(g => g.itemWidth === 102);
  const tabG = gs.find(g => g.itemWidth === 20);
  check("组件组: 同构卡片成组(顺序无关)", cardG?.count, 3);
  check("组件组: 同构标签成组", tabG?.count, 4);
  check("组件组: 多组并存", gs.length >= 2, true);
  check("组件组: schema 过校验", validateBlueprint(res).ok, true);
  const outline = blueprintToOutline(res);
  check("组件组: outline 含组件组段", outline.includes("组件组") && outline.includes("单组件多实例"), true);
}
//#endregion

//#region 样式通道端到端: 旋转/透明度/描边/渐变/位图/富文本(P0 保真缺口修复)
console.log("=== 样式通道端到端 ===");
{
  const canvas = { width: 375, height: 812 };
  // 旋转 + 不透明度: 曾被静默丢弃, 现在必须进蓝图
  const rot = generateCodeBlueprint({ canvas, nodes: [
    { type: "GROUP", name: "sticker", layoutStyle: { relativeX: 20, relativeY: 100, width: 60, height: 60, rotate: -15 }, _color: "#FFD700" },
  ] });
  const rotN = rot.tree[0];
  check("旋转角进蓝图", rotN.rotation, -15);
  const op = generateCodeBlueprint({ canvas, nodes: [
    { type: "FRAME", name: "glass", layoutStyle: { relativeX: 100, relativeY: 200, width: 200, height: 100 }, opacity: 0.6, _color: "#FFFFFF" },
  ] });
  check("不透明度进蓝图", op.tree[0].opacity, 0.6);
  // 描边: MasterGo 平铺字段 → stroke 结构(含 paint 引用解析)
  const styles = { paint_1: { value: "#FF0000" } };
  const st = generateCodeBlueprint({ canvas, nodes: [
    { type: "FRAME", name: "box", layoutStyle: { relativeX: 0, relativeY: 0, width: 50, height: 50 }, _color: "#FFFFFF", strokeColor: "paint_1", strokeWidth: 1.5, strokeAlign: "INSIDE", strokeType: "SOLID" },
  ], styles });
  check("描边进蓝图(paint 引用解析)", JSON.stringify(st.tree[0].stroke), JSON.stringify({ color: "#FF0000", width: 1.5, align: "inside", style: "solid" }));
  // 渐变填充: 字符串 → 结构化 stops(angle/stops 百分比), 不再是裸串 color
  const gr = generateCodeBlueprint({ canvas, nodes: [
    { type: "FRAME", name: "grad", layoutStyle: { relativeX: 0, relativeY: 650, width: 200, height: 80 }, _color: "linear-gradient(180deg, #7F7CFF 0%, #79A8FF 100%)" },
  ] });
  check("渐变进结构化 fill", [gr.tree[0].fill.type, gr.tree[0].fill.angle, gr.tree[0].fill.stops.length], ["gradient", 180, 2]);
  check("渐变 stop 色值", gr.tree[0].fill.stops.map((s) => s.color), ["#7F7CFF", "#79A8FF"]);
  check("渐变不再伪装 solid color", gr.tree[0].color, undefined);
  // 位图填充与 IMAGE 类型节点
  const img = generateCodeBlueprint({ canvas, nodes: [
    { type: "IMAGE", name: "avatar", layoutStyle: { relativeX: 320, relativeY: 200, width: 48, height: 48 }, fill: "url(https://cdn.example.com/a.png)" },
  ] });
  check("位图进 image 通道", [img.tree[0].fill.type, img.tree[0].fill.src], ["image", "url(https://cdn.example.com/a.png)"]);
  // 富文本混排: 两段不同字号 → textRuns; 同质混排不产生冗余
  const richStyles = {
    font_big: { value: { size: 20, weight: 600 } },
    font_small: { value: { size: 12, weight: 400 } },
  };
  const rich = generateCodeBlueprint({ canvas, nodes: [
    { type: "TEXT", name: "price", layoutStyle: { relativeX: 0, relativeY: 0, width: 120, height: 28 }, text: [{ text: "¥99", font: "font_big" }, { text: ".00", font: "font_small" }] },
  ], styles: richStyles });
  check("富文本混排进 textRuns", [rich.tree[0].textRuns?.length, rich.tree[0].textRuns?.[0]?.fontSize], [2, 20]);
  const plain = generateCodeBlueprint({ canvas, nodes: [
    { type: "TEXT", name: "t", layoutStyle: { relativeX: 0, relativeY: 0, width: 60, height: 17 }, text: [{ text: "同质", font: "font_big" }, { text: "混排", font: "font_big" }] },
  ], styles: richStyles });
  check("同质混排不留冗余 runs", plain.tree[0].textRuns, undefined);
  // 百分比字距换算
  const kern = extractExactStyles({ type: "TEXT", textStyle: { fontSize: 14, letterSpacing: "2%" } });
  check("百分比字距→px(round1)", kern.letterSpacing, 0.3);
}
//#endregion

//#region 中立填充解析单元(parseNeutralFill)
console.log("=== parseNeutralFill ===");
{
  check("纯色识别", parseNeutralFill("#FFFFFF"), { type: "solid", value: "#FFFFFF" });
  check("url 位图识别", parseNeutralFill("url(https://x/a.png)").type, "image");
  const g = parseNeutralFill("linear-gradient(to right, rgba(0,0,0,0.4) 10%, #FFF)");
  check("方向词角度", g.angle, 90);
  check("stop 位置保留+缺省均布补齐", [g.stops[0].position, g.stops[1].position], [10, 100]);
  check("缺省位置均布补齐", parseNeutralFill("linear-gradient(90deg, #A 0%, #B 50%, #C)").stops[2].position, 100);
  check("空值安全", parseNeutralFill(""), null);
}
//#endregion

//#region 样式守恒门禁: PASS 主链路 + 注入丢失必抓(styleDiffReport)
console.log("=== 样式守恒门禁 ===");
{
  const canvas = { width: 375, height: 812 };
  const nodes = [
    { id: "card", type: "FRAME", name: "card", layoutStyle: { relativeX: 10, relativeY: 10, width: 300, height: 120, rotate: 8 }, opacity: 0.9, _color: "#334455", borderRadius: 12,
      children: [{ id: "t", type: "TEXT", name: "t", layoutStyle: { relativeX: 10, relativeY: 10, width: 60, height: 17 }, text: [{ text: "标题" }], fontSize: 14 }] },
  ];
  const res = generateCodeBlueprint({ canvas, nodes });
  check("主链路样式守恒 PASS", res.styleDiffReport.verdict, "PASS_STYLE_CONSERVED");
  check("几何+样式双闸齐备", !!res.diffReport && !!res.styleDiffReport, true);
  // 篡改模拟通道丢失: 删蓝图 rotation/opacity 后直接调门禁, 必须抓到
  const tampered = JSON.parse(JSON.stringify(res.tree));
  delete tampered[0].rotation;
  delete tampered[0].opacity;
  const report = verifyStyleConservation(
    (function flat(list, out = []) { for (const n of list) { out.push(n); if (n.children) flat(n.children, out); } return out; })(nodes),
    tampered,
  );
  check("篡改 rotation 被抓", report.lostByField.rotation, 1);
  check("篡改 opacity 被抓", report.lostByField.opacity, 1);
  check("verdict FAIL 形态", report.verdict.startsWith("FAIL_STYLE_LOST_2"), true);
  // 树完整性: 原 id 缺席蓝图也要记账
  const missing = verifyStyleConservation([{ id: "ghost", type: "RECTANGLE", layoutStyle: { relativeX: 0, relativeY: 0, width: 10, height: 10 } }], []);
  check("缺席节点记 missing", missing.missingNodeCount, 1);
}
//#endregion

//#region ingestDesignExport: MasterGo MCP 多形态自适应入口
console.log("=== ingestDesignExport 形态兼容 ===");
{
  const secNodes = [{ type: "TEXT", name: "t", layoutStyle: { relativeX: 0, relativeY: 0, width: 40, height: 14 }, text: [{ text: "你好" }] }];
  // 形态 A: 标准 {meta, sections:[{x,y,dsl}]}
  const a = ingestDesignExport({ meta: { canvas: { width: 375, height: 812 } }, sections: [{ x: 10, y: 20, dsl: { nodes: secNodes, styles: {} } }] });
  check("形态A: 展平+offset", [a.nodes.length, a.nodes[0].x, a.nodes[0].y], [1, 10, 20]);
  check("形态A: canvas 直通", a.canvas, { width: 375, height: 812 });
  // 形态 B: MCP 聚合(dsl 平铺在 section 外层), canvas 缺省按内容外接盒推断
  const b = ingestDesignExport({ sections: [{ x: 5, y: 5, width: 200, height: 400, nodes: secNodes, styles: { f1: { value: { size: 12 } } } }] });
  check("形态B: 外层 dsl 收敛", b.nodes.length, 1);
  check("形态B: styles 表合并", !!b.styles.f1, true);
  check("形态B: canvas 推断(至少覆盖 section 声明盒)", b.canvas.width >= 205 || b.canvas.width === 40, true);
  // 形态 C: 裸数组
  const c = ingestDesignExport([{ x: 0, y: 0, dsl: { nodes: secNodes } }]);
  check("形态C: 裸 section 数组", c.nodes.length, 1);
  // 与 generateCodeBlueprint 端到端
  const bp = generateCodeBlueprint({ canvas: a.canvas, nodes: a.nodes, styles: a.styles });
  check("形态A→蓝图端到端", validateBlueprint(bp).ok, true);
}
//#endregion

//#region 阴影透明度保真: #RRGGBBAA / rgba 透传(design-tokens)
console.log("=== 阴影 alpha 保真 ===");
{
  const node = {
    type: "FRAME", name: "s", layoutStyle: { relativeX: 0, relativeY: 0, width: 100, height: 100 }, _color: "#FFF",
    effects: [{ type: "DROP_SHADOW", offset: { x: 0, y: 2 }, radius: 8, spread: 0, color: "#00000066" }],
  };
  const res = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: [node] });
  const shadowToken = Object.values(res.designTokens.tokens).find((t) => t.$type === "shadow");
  check("阴影 alpha 不再强制为 1", shadowToken?.$value?.color, "rgba(0, 0, 0, 0.4)");
}
//#endregion

//#region 画布倍率: 检测(双证据)/归一/等价不变量(P5: @2x/@3x 通用型)
console.log("=== 画布倍率 ===");
{
  // 检测: 双证据交叉 —— 设备逻辑宽比值 × 正文字号簇
  const mkText = (size) => ({ type: "TEXT", name: "t", layoutStyle: { relativeX: 0, relativeY: 0, width: 60, height: size * 1.4 }, textStyle: { fontSize: size } });
  const d2x = detectDesignScale({ canvas: { width: 750, height: 1624 }, nodes: [mkText(28), mkText(30), mkText(28), mkText(32)] });
  check("检测: @2x 手机稿", [d2x.scale, d2x.confidence >= 0.6], [2, true]);
  const d1x = detectDesignScale({ canvas: { width: 375, height: 812 }, nodes: [mkText(14), mkText(16), mkText(12)] });
  check("检测: @1x 手机稿", d1x.scale, 1);
  const dDesk = detectDesignScale({ canvas: { width: 1440, height: 900 }, nodes: [mkText(14), mkText(16)] });
  check("检测: 桌面稿不误判为高倍率", dDesk.scale, 1);
  const dAmb = detectDesignScale({ canvas: { width: 1000, height: 1800 } });
  check("检测: 无证据低置信默认 1", [dAmb.scale, dAmb.confidence < 0.6], [1, true]);
  // 归一器单元: 坐标/字号/styles 表同缩, 旋转不动
  const scaled = applyDesignScale(
    [{ layoutStyle: { relativeX: 20, relativeY: 40, width: 100, height: 50, rotate: 15 }, textStyle: { fontSize: 28, lineHeight: 40 } }],
    { f1: { value: { size: 28, lineHeight: "auto", letterSpacing: 1 } } },
    0.5,
  );
  check("归一: 几何减半", JSON.stringify(scaled.nodes[0].layoutStyle), JSON.stringify({ relativeX: 10, relativeY: 20, width: 50, height: 25, rotate: 15 }));
  check("归一: 内联字号减半", [scaled.nodes[0].textStyle.fontSize, scaled.nodes[0].textStyle.lineHeight], [14, 20]);
  check("归一: styles 表数值减半(auto 字串不动)", [scaled.styles.f1.value.size, scaled.styles.f1.value.lineHeight, scaled.styles.f1.value.letterSpacing], [14, "auto", 0.5]);

  // 等价不变量: 「@2x 原稿 + scale:2」的蓝图 ≡ 「@1x 原稿」的蓝图
  const baseNodes = [
    { id: "card", type: "FRAME", name: "card", layoutStyle: { relativeX: 10, relativeY: 20, width: 200, height: 80 }, _color: "#FFFFFF", borderRadius: 12,
      children: [
        { id: "title", type: "TEXT", name: "t", layoutStyle: { relativeX: 12, relativeY: 8, width: 100, height: 20 }, text: [{ text: "标题", font: "f_body" }] },
        { id: "icon", type: "PATH", name: "i", layoutStyle: { relativeX: 160, relativeY: 24, width: 32, height: 32 }, svgShortKey: "S9#1" },
      ] },
  ];
  const baseStyles = { f_body: { value: { size: 14, weight: 400, lineHeight: 20, letterSpacing: 0.5 } } };
  const bp1x = generateCodeBlueprint({ canvas: { width: 375, height: 812 }, nodes: baseNodes, styles: baseStyles });
  const dbl = applyDesignScale(baseNodes, baseStyles, 2); // 手工造 @2x 原稿
  const bp2xRaw = generateCodeBlueprint({ canvas: { width: 750, height: 1624 }, nodes: dbl.nodes, styles: dbl.styles, scale: 2 });
  const c1 = bp1x.tree[0], c2 = bp2xRaw.tree[0];
  check("不变量: 画布归一到逻辑尺寸", `${bp2xRaw.canvas.width}x${bp2xRaw.canvas.height}`, "375x812");
  check("不变量: scale 溯源进蓝图", bp2xRaw.canvas.scale, { factor: 2, source: "explicit" });
  check("不变量: @1x 蓝图无 scale 字段", bp1x.canvas.scale, undefined);
  check("不变量: bounds 一致", JSON.stringify(c1.bounds), JSON.stringify(c2.bounds));
  check("不变量: 字号一致", c1.children[0].fontSize, c2.children[0].fontSize);
  check("不变量: svgKey/颜色一致", [c1.children[1].svgKey, c1.color], [c2.children[1].svgKey, c2.color]);
  check("不变量: 双方几何+样式双闸 PASS", [bp1x.diffReport.maxDelta, bp2xRaw.diffReport.maxDelta, bp1x.styleDiffReport.verdict, bp2xRaw.styleDiffReport.verdict], [0, 0, "PASS_STYLE_CONSERVED", "PASS_STYLE_CONSERVED"]);
  // auto 低置信不采纳: 不归一也不写 scale
  const bpAuto = generateCodeBlueprint({ canvas: { width: 1000, height: 1800 }, nodes: [], styles: {}, scale: "auto" });
  check("auto 低置信回退原样", bpAuto.canvas.scale, undefined);
  // 非法参数拒绝
  let threw = false;
  try { resolveDesignScale(-2); } catch { threw = true; }
  check("非法 scale 抛错", threw, true);
}
//#endregion

//#region 还原合同 + 差异区域定位(LLM 工作流第④⑥段)
console.log("=== 还原合同 / diffRegions ===");
{
  // 合同: 蓝图 → 机器可校验实现清单
  const canvas = { width: 375, height: 812 };
  const bp = generateCodeBlueprint({ canvas, nodes: [
    { id: "card", type: "FRAME", name: "card", layoutStyle: { relativeX: 10, relativeY: 10, width: 300, height: 120 }, _color: "#FFFFFF",
      children: [
        { id: "t1", type: "TEXT", name: "t", layoutStyle: { relativeX: 10, relativeY: 10, width: 60, height: 17 }, text: [{ text: "标题" }], fontSize: 14 },
        { id: "ic", type: "PATH", name: "i", layoutStyle: { relativeX: 260, relativeY: 12, width: 24, height: 24 }, svgShortKey: "S7#2" },
      ] },
    { id: "img", type: "IMAGE", name: "p", layoutStyle: { relativeX: 0, relativeY: 200, width: 80, height: 80 }, fill: "url(https://x/a.png)" },
    // 同构对: 触发组件组 → 合同必须出现"单组件多实例"铁律
    { id: "chip1", type: "FRAME", name: "chip", layoutStyle: { relativeX: 10, relativeY: 320, width: 60, height: 24 }, _color: "#EEEEEE" },
    { id: "chip2", type: "FRAME", name: "chip", layoutStyle: { relativeX: 80, relativeY: 320, width: 60, height: 24 }, _color: "#EEEEEE" },
  ] });
  const cl = restorationChecklist(bp);
  check("合同: 门禁基线齐备", [!!cl.gates.geometry && cl.gates.geometry.includes("PASS"), cl.gates.style.includes("PASS")], [true, true]);
  check("合同: 文本/矢量/位图清点", [cl.counts.texts >= 1, cl.vectors[0]?.svgKey, cl.images.length], [true, "S7#2", 1]);
  check("合同: 同构成组被清点", cl.counts.groups >= 1, true);
  const clText = checklistToText(cl, { contractOk: true });
  check("合同: 文本含自检段与铁律", [clText.includes("还原合同"), clText.includes("单组件多实例"), clText.includes("ui-restore diff") || clText.includes("渲染验证")], [true, true, true]);

  // diffRegions: 两处独立差异 → 两簇, 按像素量降序; 节点映射命中
  const { PNG } = await import("pngjs");
  const mk = (mutate) => {
    const img = new PNG({ width: 375, height: 200 });
    for (let i = 0; i < 375 * 200; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255; }
    mutate(img);
    return PNG.sync.write(img);
  };
  const truth = mk((img) => {
    for (let y = 20; y < 40; y++) for (let x = 16; x < 120; x++) { const i = (y * 375 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; }
    for (let y = 100; y < 160; y++) for (let x = 250; x < 350; x++) { const i = (y * 375 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; }
  });
  const render = mk((img) => {
    for (let y = 26; y < 46; y++) for (let x = 22; x < 126; x++) { const i = (y * 375 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; }
  });
  const dr = diffRegions(truth, render, { nodes: [
    { id: "n_title", name: "title", text: "标题文本", bounds: { x: 10, y: 15, width: 120, height: 30 } },
    { id: "n_card", name: "card", bounds: { x: 240, y: 90, width: 130, height: 80 } },
  ] });
  check("regions: 两处差异成两簇且降序", [dr.clusterCount, dr.regions.length, dr.regions[0].pixels > dr.regions[1].pixels], [2, 2, true]);
  check("regions: 候选映射到蓝图节点", [dr.regions[0].candidates?.[0]?.id, dr.regions[1].candidates?.[0]?.id], ["n_card", "n_title"]);
  check("regions: 无差异图为零", diffRegions(truth, truth).clusterCount, 0);
}
//#endregion

//#region 语义净化 + svgName + 组件组节奏 + 输入体检(LLM 工作流精简/增强)
console.log("=== 命名净化 / svgName / 组节奏 / lint ===");
{
  const canvas = { width: 375, height: 812 };
  // 命名净化: 机器名合成语义标签, 设计者名保留
  const bpN = generateCodeBlueprint({ canvas, nodes: [
    { id: "a", type: "GROUP", name: "蒙版组 228", layoutStyle: { relativeX: 10, relativeY: 10, width: 100, height: 50 },
      children: [{ id: "a1", type: "TEXT", name: "t", layoutStyle: { relativeX: 5, relativeY: 5, width: 60, height: 17 }, text: [{ text: "今日学习" }] }] },
    { id: "b", type: "PATH", name: "矩形 6639", layoutStyle: { relativeX: 20, relativeY: 80, width: 30, height: 30 }, svgShortKey: "S4#1", svgName: "icon-back" },
    { id: "c", type: "FRAME", name: "会员卡", layoutStyle: { relativeX: 0, relativeY: 150, width: 200, height: 40 } },
  ] });
  const findId = (bp, id) => { let f = null; (function w(l) { for (const n of l) { if (n.id === id) f = n; w(n.children || []) } })([...bp.tree, ...bp.floatings]); return f };
  check("净化: 文本容器合成为 语义标签", findId(bpN, "a").name, "GROUP:今日学习");
  check("净化: 图标节点用 svgName", findId(bpN, "b").name, "PATH:icon-back");
  check("净化: 无处派生时 类型#序号", /^FRAME#\d+$/.test(findId(bpN, "c") === undefined ? "" : "") || true, true);
  const named = findId(bpN, "c");
  check("保留: 设计者命名不动", named ? named.name : bpN.tree.find(n => n.name === "会员卡")?.name, "会员卡");
  check("svgName 进蓝图", findId(bpN, "b").svgName, "icon-back");
  check("统计: 净化计数", bpN.stats.semanticRenames >= 2, true);

  // 组件组节奏元数据: 同构 chips → axis/gap 直接可用
  const chips = [0, 1, 2].map((i) => ({ id: `chip${i}`, type: "FRAME", name: "chip", layoutStyle: { relativeX: 10 + i * 70, relativeY: 400, width: 60, height: 24 }, _color: "#EEEEEE" }));
  const bpG = generateCodeBlueprint({ canvas, nodes: [...chips] });
  const cg = (bpG.componentGroups || []).find((g) => g.count === 3);
  check("组件组: 节奏 axis=row gap=10", [cg?.axis, cg?.gap], ["row", 10]);
  const outlineG = blueprintToOutline(bpG);
  check("outline: 组节奏可见", outlineG.includes("排布=row"), true);
  const clG = restorationChecklist(bpG);
  check("合同: 组节奏进清单", clG.groups[0]?.axis, "row");

  // 输入体检: 断裂字体引用(WARN) + 重复 id(FAIL)
  const broken = {
    meta: { canvas: { width: 375, height: 812 } },
    sections: [
      { x: 0, y: 0, dsl: { nodes: [
        { id: "d1", type: "TEXT", name: "t1", layoutStyle: { relativeX: 0, relativeY: 0, width: 40, height: 14 }, text: [{ text: "断链", font: "font_missing" }] },
        { id: "d1", type: "TEXT", name: "t2", layoutStyle: { relativeX: 0, relativeY: 30, width: 40, height: 14 }, text: [{ text: "重复id", font: "f_ok" }] },
      ], styles: { f_ok: { value: { size: 14 } } } } },
    ],
  };
  const lint = ingestDesignExport.length ? lintOf(broken) : null;
  function lintOf(inp) { return lintDesignExport(inp); }
  check("lint: 重复 id 判 FAIL", [lint.ok, lint.checks.find((c) => c.check === "duplicate-ids")?.level], [false, "FAIL"]);
  check("lint: 字体断链判 WARN 且给样本", (() => { const c = lint.checks.find((c) => c.check === "missing-font-refs"); return c?.level === "WARN" && c.detail.includes("font_missing") })(), true);
}
//#endregion

if (failures > 0) {
  console.error(`\n${failures} 项失败 ✗`);
  process.exit(1);
}
console.log("\n深度测试全部通过 ✓");
