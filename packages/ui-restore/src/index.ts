// @ui-restore/core — 通用 UI 还原核心
//
// 职责铁律:只回答"设计稿 → 描述产物(中立蓝图) → 验证",代码生成永远在下游。
// 零宿主依赖:不感知 dsh/配额/会话;技术栈中立:产物不含任何技术栈字面量。
//
// 四段流水线(接口化,单段可替换):
//   ingest   设计源 DSL → 归一化节点(dsl-clean)
//   infer    布局反推 + 真值自愈(layout-core / yoga-truth / repeat)
//   describe 样式/Token/文本度量/图标引用(design-tokens / text-metrics)
//   verify   几何守恒 + 像素/块级对比(layout-core.autoHealing / visual-diff)
export * from "./dsl-clean.ts";
export * from "./layout-core.ts";
export * from "./repeat.ts";
export * from "./system-chrome.ts";
export * from "./yoga-truth.ts";
export * from "./design-tokens.ts";
export * from "./text-metrics.ts";
export * from "./visual-diff.ts";
export * from "./scale.ts";
export * from "./ir/schema.ts";
export * from "./ir/outline.ts";
export * from "./ir/ingest.ts";
export * from "./ir/checklist.ts";
