'use strict'
// design-critique — 设计批判（不一致检测与建议，超越像素还原的设计质量）
// 输入：blueprint（typographyProfile/palette/regions/tree），输出：批判报告

export function critiqueDesign({ blueprint, tree }: Record<string, any> = {}) {
  const t = tree || blueprint?.tree || []
  const profile: Record<string, any> = blueprint?.typographyProfile || {}
  const palette = blueprint?.palette || []
  const issues = []
  const suggestions = []

  // 1. 间距一致性：gap/padding 值是否离散（应聚类到少数 scale）
  const gaps = new Set()
  function collectGaps(nodes: any) {
    for (const n of nodes) {
      if (n.computed?.gap) gaps.add(n.computed.gap)
      if (n.layout?.gap) gaps.add(n.layout.gap)
      if (n.children) collectGaps(n.children)
    }
  }
  collectGaps(Array.isArray(t) ? t : [t])
  if (gaps.size > 6) {
    issues.push({ type: 'spacing', severity: 'warning', count: gaps.size, reason: `gap 值离散 ${gaps.size} 种（${[...gaps].slice(0,5).join(',')}），建议收敛到 3-4 档` })
    suggestions.push('收敛 gap 到 8/16/24/32 scale')
  }

  // 2. 色彩数量：palette 是否过多（>8 种主色可能过杂）
  if (palette.length > 8) {
    issues.push({ type: 'color', severity: 'warning', count: palette.length, reason: `主色 ${palette.length} 种过多，建议收敛到 4-6 种` })
    suggestions.push('合并近似色（ΔE<5）')
  }

  // 3. 字体种类：是否过多字体族
  const families = new Set(Object.values(profile as Record<string, any>).map(p => p.family).filter(Boolean))
  if (families.size > 3) {
    issues.push({ type: 'typography', severity: 'warning', count: families.size, families: [...families], reason: `字体族 ${families.size} 种（${[...families].join(',')}）过多` })
    suggestions.push('收敛到 1-2 字体族（标题/正文）')
  }

  // 4. 对比度（复用 a11y 逻辑简化）
  const lowContrast = Object.entries(profile).filter(([_, p]) => p.color && p.color.toLowerCase() === '#ffffff').length
  if (lowContrast > 3) {
    issues.push({ type: 'contrast', severity: 'info', count: lowContrast, reason: `多处白色文字，需确认背景对比度` })
  }

  return {
    issues,
    suggestions,
    score: Math.max(0, 10 - issues.length * 2),
    summary: issues.length ? `${issues.length} 设计问题` : '设计一致性良好',
  }
}
