'use strict'
// viewport-matrix — 多视口/多状态矩阵聚合（doc13 §5.1/§6.3）
// 输入：viewports × states 的逐项分数/截图，输出：聚合总分与最差视口/状态
// 与 browser_viewport / browser_state_trigger / compare_screenshots 联动

import { VIEWPORTS, REGION_WEIGHT } from '../config.ts'

export const DEFAULT_VIEWPORTS = [
  { name: 'desktop', ...VIEWPORTS.desktop },
  { name: 'tablet', ...VIEWPORTS.tablet },
  { name: 'mobile', ...VIEWPORTS.mobile },
]
export const DEFAULT_STATES = ['default', 'hover', 'active', 'disabled']

/**
 * 展开矩阵（笛卡尔积）
 * @param viewports [{name,width,height,dpr}] 或 ['desktop','mobile']
 * @param states ['default','hover']
 * @returns [{viewport, state, key}]
 */
export function expandMatrix({ viewports = DEFAULT_VIEWPORTS, states = DEFAULT_STATES }: Record<string, any> = {}) {
  const vps = viewports.map((v: any) => typeof v === 'string' ? { name: v, ...(VIEWPORTS[v] || VIEWPORTS.desktop), nameStr: v } : v)
  const out = []
  for (const vp of vps) {
    for (const st of states) {
      out.push({ viewport: vp, state: st, key: `${vp.name}-${st}` })
    }
  }
  return out
}

/**
 * 聚合评分（doc13 §6.3：P0 区域权重×2，已在单视口 score 中体现；多视口取加权均值，移动端容差放宽）
 * @param results [{key, viewport, state, score:{total, layers}}]
 * @param opts.weights {desktop:1, tablet:0.8, mobile:0.6} 视口权重
 */
export function aggregateMatrixScores(results: any, { weights = { desktop: 1, tablet: 0.8, mobile: 0.6 } }: Record<string, any> = {}) {
  if (!results.length) return { aggregate: 0, byViewport: {}, worst: null, best: null }
  const byViewport = {}
  let weightedSum = 0, weightSum = 0
  let worst = null, best = null
  for (const r of results) {
    const vpName = r.viewport?.name || r.viewport || 'unknown'
    const w = weights[vpName] ?? 1
    const total = r.score?.total ?? r.total ?? 0
    if (!byViewport[vpName]) byViewport[vpName] = { scores: [], avg: 0, min: Infinity, max: -Infinity }
    byViewport[vpName].scores.push(total)
    weightedSum += total * w
    weightSum += w
    if (!worst || total < worst.score.total) worst = r
    if (!best || total > best.score.total) best = r
  }
  for (const vp of Object.keys(byViewport)) {
    const arr = byViewport[vp].scores
    byViewport[vp].avg = arr.reduce((a: any, b: any) => a + b, 0) / arr.length
    byViewport[vp].min = Math.min(...arr)
    byViewport[vp].max = Math.max(...arr)
  }
  const aggregate = weightSum ? Math.round((weightedSum / weightSum) * 1000) / 1000 : 0
  return { aggregate, byViewport, worst, best, count: results.length }
}

/**
 * 检查响应式一致性（doc13 §6.3：移动端不应出现 P0 布局断裂）
 * @param results 同上
 * @param threshold 0.85 低于此视为断裂
 */
export function checkResponsive(results: any, threshold = 0.85) {
  const issues = []
  for (const r of results) {
    const total = r.score?.total ?? r.total ?? 0
    if (total < threshold) {
      issues.push({ key: r.key, viewport: r.viewport?.name, state: r.state, total, threshold, severity: r.viewport?.name === 'mobile' ? 'warning' : 'error' })
    }
  }
  return { passed: issues.length === 0, issues, summary: issues.length ? `responsive issues: ${issues.length}` : 'responsive ok' }
}
