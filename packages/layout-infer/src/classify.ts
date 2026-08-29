// classify — 还原决策分类层(Step 1)的壳包再导出
//
// ⚠️ 正本归一(doc19 §2.2 批3, 2026-08-29): classify 实现已随 v2 正本整体并入
// @3kaiu/dsh-plugin-kit(语言无关纯几何判定 + repeat/system-chrome),
// layout-infer 作为壳包自 kit 再导出, 不再持有本地实现副本。
// 信号优先级(从强到弱, 实现见 kit):
//   1. 原生约束直读: flexContainerInfo.mainSizing/crossSizing、textMode、
//      flexContainerInfo.alignItems —— MasterGo 自动布局给出的官方答案,零推断
//   2. 类型直读: TEXT / PATH / image-fill —— 决定 text/icon/image
//   3. 语义命名: icon/logo/img/avatar 等设计规范约定
//   4. 几何反推: gap/padding(无原生间距字段时复用 inferLayout)
export {
  classifyDsl, classifyNode, kindOf, sizingOf, positionOf, spacingOf, paintValue, resolvePaint, svgOf,
} from '@3kaiu/dsh-plugin-kit'
