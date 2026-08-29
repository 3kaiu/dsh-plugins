// @3kaiu/dsh-plugin-kit — DeepSeek Harness 插件公共能力
//
// 被各插件包在构建时 bundle 进 dist(不要求运行时安装),
// 同时以源码形式对外发布,供其他插件/MasterGo 工具 import。
export * from "./quota-tracker.ts";
export * from "./semaphore.ts";
export * from "./layout-core.ts";
export * from "./dsl-clean.ts";
export * from "./cluster.ts";
export { clusterBandsAdaptive } from "./cluster.ts"; // 显式再导出消歧(dsl-clean 的同名再导出与 cluster 星号导出冲突, TS2308)
export * from "./dom-to-layout.ts";
export * from "./compare.ts";
export * from "./geometry.ts";
export * from "./typography.ts";
export * from "./cjk.ts";
export * from "./url-guard.ts";
export * from "./repeat.ts";
export * from "./system-chrome.ts";
export { classifyDsl, classifyNode, kindOf, sizingOf, positionOf, spacingOf, paintValue, resolvePaint, svgOf } from "./classify.ts";
export * from "./palette.ts";
export * from "./pixel.ts";
export * from "./score.ts";
export * from "./antihack.ts";
export * from "./selfcorrect.ts";
export * from "./blueprint.ts";
export * from "./test-utils.ts";
