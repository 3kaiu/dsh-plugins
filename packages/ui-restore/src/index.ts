// @ui-restore/core — 通用 UI 还原核心
//
// 职责(v4 方案):设计稿 → 描述产物(中立蓝图) → 验证 → Target 层(蓝图+项目画像 → 受限生成/修复)。
// 蓝图产物保持技术栈中立(不含任何技术栈字面量); 技术栈决策集中在 src/target(Profile/Contract),
// 生成物只经 emit 落到目标项目, 不回写蓝图。
//
// 四段流水线(接口化,单段可替换):
//   ingest   设计源 DSL → 归一化节点(dsl-clean)
//   infer    布局反推 + 真值自愈(layout-core / yoga-truth / repeat)
//   describe 样式/Token/文本度量/图标引用(design-tokens / text-metrics)
//   verify   几何守恒 + 像素/块级对比(layout-core.autoHealing / visual-diff)
//   target   项目理解(Analyzer/Resolver) + 生成契约 + 资产解析 + 受限 Patch(target/)
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
// 还原决策分类(kind/sizing/position/spacing): 自 layout-infer 壳包归位 core(壳只留工具注册面)
export * from "./classify.ts";
// Target 层(v4): 项目理解 → Target Profile → 生成契约 → 资产解析 → 受限 Patch + 库映射
export * from "./target/types.ts";
export * from "./target/detect.ts";
export * from "./target/resolve.ts";
export * from "./target/profile.ts";
export * from "./target/contract.ts";
export * from "./target/asset-resolver.ts";
export * from "./target/component-map.ts";
// verify 扩展(v4 Phase 3): 组合验收 / 错误分类 / 收敛评分 / Vision 兜底
export * from "./verify/errors.ts";
export * from "./verify/gate.ts";
export * from "./verify/score.ts";
export * from "./verify/vision.ts";
// emit(v4 Phase 2): Strategy IR → React/Vue/Flutter/MiniProgram/preview 序列化(多重 serializer ⑭⑮⑯⑰)
export * from "./emit/style-ir.ts";
export * from "./emit/react.ts";
export * from "./emit/html.ts";
export * from "./emit/tailwind.ts";
export * from "./emit/vue.ts";
export * from "./emit/flutter.ts";
export * from "./emit/miniprogram.ts";
export * from "./emit/registry.ts";
// Enhancement Semantic ⑲
export * from "./ir/semantic.ts";
// V2 Merge ⑳
export * from "./target/merge.ts";
// target 受限 Patch 契约与校验(⑨⑪)
export * from "./target/patch.ts";
