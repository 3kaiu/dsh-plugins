'use strict'
// ui-reverse-agent 全局阈值/权重/容差（集中配置，对应 13 §6.2、§8.1）

export const TOL = 2 // 视觉保真容差 px

// 评分权重（§6.3）
export const WEIGHTS = {
  struct: 0.30,
  geom: 0.30,
  pixel: 0.20,
  type: 0.10,
  color: 0.10,
} as const

// 完成阈值
export const COMPLETE_THRESHOLD = 0.96
export const REGRESSION_DELTA = -0.02
export const NO_PROGRESS_DELTA = 0.005
export const REGRESSION_LAYER_DROP = 0.05
export const STAGNATION_ROUNDS = 3
export const MAX_ITERATIONS = 30

// 反 hack 阈值（§8.1）
export const ANTIHACK = {
  absoluteLeafRatio: 0.15, // >15% blocker
  canvasCoverage: 0.60, // canvas 面积 >60% 且文本缺失
  backgroundHashSim: 0.95,
  hiddenDomRatio: 0.10,
  inlineStyleCount: 10,
  importantCount: 10,
  negativeMarginCount: 3,
  mediaQueryPixelCover: 20, // warning: 单一 media query 内像素覆盖 >20条
} as const

// 视口预设
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, dpr: 2 },
  tablet: { width: 768, height: 1024, dpr: 2 },
  mobile: { width: 375, height: 812, dpr: 2 },
} as const

// 区域优先级权重（P0 ×2）
export const REGION_WEIGHT = { P0: 2, P1: 1, P2: 1, P3: 0.5 } as const
