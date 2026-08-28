'use strict'
// evaluation — 还原质量的量化评估（超越 S 的多维评估）

export function evaluateRestoration({ blueprint, implementedTree, score, verify, a11y, durationMs }) {
  const dimensions = {
    visual: score?.total ?? 0,
    geometry: score?.layers?.geom ?? 0,
    typography: score?.layers?.type ?? 0,
    color: score?.layers?.color ?? 0,
    structure: score?.layers?.struct ?? 0,
    accessibility: a11y?.passed ? 1 : a11y ? 0.5 : 1,
    correctness: verify?.passed ? 1 : 0.7,
  }
  const weighted = dimensions.visual * 0.4 + dimensions.geometry * 0.2 + dimensions.typography * 0.15 + dimensions.color * 0.1 + dimensions.accessibility * 0.1 + dimensions.correctness * 0.05
  return {
    dimensions,
    weighted: Math.round(weighted * 1000) / 1000,
    durationMs: durationMs ?? 0,
    grade: weighted >= 0.95 ? 'A' : weighted >= 0.85 ? 'B' : weighted >= 0.7 ? 'C' : 'D',
    summary: `Grade ${weighted >= 0.95 ? 'A' : weighted >= 0.85 ? 'B' : 'C'} — visual ${dimensions.visual} + a11y ${dimensions.accessibility}`,
  }
}
