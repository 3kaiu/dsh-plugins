'use strict'
// score_report：加权总分 + 分层分 + ΔS + regression 标记 + 完成判定
// S = 0.30*S_struct + 0.30*S_geom + 0.20*S_pixel + 0.10*S_type + 0.10*S_color
// 每层 S ∈ [0,1]；P0 区域分数 <0.9 时总分不可达阈值（提升权重在调用方处理）

const W = { struct: 0.30, geom: 0.30, pixel: 0.20, type: 0.10, color: 0.10 }
const THRESH = 0.96
const REGRESSION_DELTA = -0.02
const REGRESSION_LAYER_DROP = 0.05

// 将各类工具输出归一化为 0..1 分数

function structScoreFromCompare(compareLayoutsResult: any) {
  if (!compareLayoutsResult) return null
  const { matched = 0, missing = [], extra = [] } = compareLayoutsResult
  const denom = matched + missing.length
  if (denom === 0) return 1
  return Math.max(0, Math.min(1, matched / denom))
}

function geomScoreFromGeometry(compareGeometryResult: any, containerSize: any = 1440) {
  if (!compareGeometryResult) return null
  const { stats } = compareGeometryResult
  if (!stats) return null
  const { meanDelta = 0, maxDelta = 0 } = stats
  // 归一：1 - meanDelta / 容器参考尺寸（默认 1440），配合 maxDelta 惩罚
  const base = 1 - Math.min(1, meanDelta / 50) // 50px 平均偏差即 0 分
  const penalty = Math.min(0.3, maxDelta / 200) // 最大偏差>200px 罚 0.3
  return Math.max(0, Math.min(1, base - penalty))
}

function pixelScoreFromScreenshots(compareScreenshotsResult: any) {
  if (!compareScreenshotsResult) return null
  const { ssim } = compareScreenshotsResult
  if (typeof ssim !== 'number') return null
  return Math.max(0, Math.min(1, ssim))
}

function typeScoreFromTypography(compareTypographyResult: any) {
  if (!compareTypographyResult) return null
  const { stats } = compareTypographyResult
  if (!stats) return null
  const { referenceTextNodes = 0, mismatched = 0 } = stats
  if (referenceTextNodes === 0) return 1 // 无文本不扣分
  return Math.max(0, Math.min(1, 1 - mismatched / Math.max(1, referenceTextNodes)))
}

function colorScoreFromPalette(comparePaletteResult: any) {
  if (!comparePaletteResult) return null
  const { stats } = comparePaletteResult
  if (!stats) return null
  const { fails = 0, total = 0, meanDeltaE = 0 } = stats
  if (total === 0) return 1
  // 双重：失败率 + 平均 ΔE
  const failRate = fails / total
  const dePenalty = Math.min(0.5, meanDeltaE / 20) // ΔE 20 即罚 0.5
  return Math.max(0, Math.min(1, 1 - failRate * 0.7 - dePenalty * 0.3))
}

function weightedTotal(layers: any) {
  let sum = 0, wsum = 0
  for (const k of ['struct','geom','pixel','type','color']) {
    const v = layers[k]
    if (typeof v === 'number') { sum += v * (W[k] ?? 0); wsum += (W[k] ?? 0) }
  }
  if (wsum === 0) return 0
  return sum / wsum * (Object.keys(W).length / (Object.keys(W).length)) // wsum 已为 1，简化
  // 实际：若部分层缺失，按已有权重归一
  // return wsum < 0.99 ? sum / wsum : sum
}

export function scoreReport({
  // 方式1：直接传层分数
  struct, geom, pixel, type, color,
  // 方式2：传工具原始输出，自动归一
  compareLayouts, compareGeometry, compareScreenshots, compareTypography, comparePalette,
  //  历史
  previousTotal,
  history = [],
  // 守卫
  blocked = false,
  // 额外
  containerSize,
  completeThreshold,
}: Record<string, any> = {}) {
  // 归一化层分数（显式传入优先，否则从工具输出推导）
  const layers: Record<string, any> = {}
  layers.struct = typeof struct === 'number' ? struct : structScoreFromCompare(compareLayouts)
  layers.geom = typeof geom === 'number' ? geom : geomScoreFromGeometry(compareGeometry, containerSize)
  layers.pixel = typeof pixel === 'number' ? pixel : pixelScoreFromScreenshots(compareScreenshots)
  layers.type = typeof type === 'number' ? type : typeScoreFromTypography(compareTypography)
  layers.color = typeof color === 'number' ? color : colorScoreFromPalette(comparePalette)

  // 缺失层按 1 处理（不参与惩罚）？改为按已有层归一，避免无该层数据时总分被拉低
  const present = Object.entries(layers).filter(([,v]) => typeof v === 'number') as [string, number][]
  let total
  if (blocked) {
    total = -1
  } else if (present.length === 0) {
    total = 0
  } else if (present.length < 5) {
    // 部分层缺失：按已有权重归一
    let sum = 0, wsum = 0
    for (const [k,v] of present) { sum += v * (W[k] ?? 0); wsum += (W[k] ?? 0) }
    total = wsum > 0 ? sum / wsum : 0
  } else {
    total = weightedTotal(layers)
  }
  total = Math.round(total * 1000) / 1000

  const th = completeThreshold ?? THRESH
  const delta = typeof previousTotal === 'number' ? Math.round((total - previousTotal)*1000)/1000 : null

  // regression 检测
  let regression = false, regressionReason = null
  if (typeof delta === 'number' && delta <= REGRESSION_DELTA) {
    regression = true
    regressionReason = `ΔS ${delta} ≤ ${REGRESSION_DELTA}`
  } else if (compareScreenshots && typeof compareScreenshots.ssim === 'number' && typeof previousTotal === 'number') {
    // 单层大幅下降也算
  }
  // 检查层分数骤降
  if (!regression && Array.isArray(history) && history.length) {
    const last = history[history.length-1]
    if (last && typeof last.total === 'number') {
      for (const k of ['struct','geom','pixel','type','color']) {
        const cur = layers[k], prev = last[k]
        if (typeof cur === 'number' && typeof prev === 'number' && (prev - cur) > REGRESSION_LAYER_DROP) {
          regression = true
          regressionReason = `${k} ${prev} → ${cur} drop > ${REGRESSION_LAYER_DROP}`
          break
        }
      }
    }
  }

  // 完成判定：总分达标且无 blocker 且各层 P0 无严重失败（由调用方传入）
  const complete = !blocked && total >= th && !regression

  // 区域加权提示：若 pixel 层 regionScores 中 P0 <0.9，总分不可达阈值（此处仅标记）
  let p0Fail = false
  if (compareScreenshots && Array.isArray(compareScreenshots.regionScores)) {
    for (const r of compareScreenshots.regionScores) {
      if (r.priority === 'P0' && typeof r.ssim === 'number' && r.ssim < 0.9) p0Fail = true
    }
  }

  return {
    total, layers, delta, regression, regressionReason, blocked, complete, threshold: th, p0Fail,
    weights: { ...W },
  }
}

// 便捷：从工具输出直接算总分（供 state/history 使用）
export function quickScore(layers: any) {
  return weightedTotal(layers)
}
