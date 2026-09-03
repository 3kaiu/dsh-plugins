'use strict'
// integration — 真实项目端到端验证 harness（非浏览器集成，供 CI/本地回归）
// 输入：fixture（neutralTree + 预期分数），输出：端到端报告

import { neutralToBlueprint } from '../perception/neutral-ingest.ts'
import { compareGeometry } from '../measure/geometry.ts'
import { scoreReport } from '../compare/score.ts'
import { verifyNeutral } from '../guard/verify-neutral.ts'
import { checkA11y } from '../guard/a11y.ts'

export function runIntegrationFixture({ neutral, implementedTree, expectedScore = 0.96 }: any) {
  const blueprint = neutralToBlueprint(neutral)
  const geom = compareGeometry({ referenceTree: blueprint.tree, implementedTree, tolerance: 2 })
  const score = scoreReport({ struct: 0.9, geom: geom.mismatches.length === 0 ? 1 : 0.9, pixel: 0.9, type: 0.9, color: 0.9 })
  const verify = verifyNeutral({ neutral, blueprint, implementedTree, tolerance: 2 })
  const a11y = checkA11y({ tree: implementedTree })
  const passed = score.total >= expectedScore && verify.passed && a11y.passed
  return {
    blueprint: { regions: blueprint.regions.length, assets: blueprint.assets },
    geom: { mismatches: geom.mismatches.length, matched: geom.matched },
    score,
    verify,
    a11y,
    passed,
    summary: passed ? `integration pass S ${score.total}` : `fail S ${score.total} verify ${verify.passed} a11y ${a11y.passed}`,
  }
}

export function integrationSuite(fixtures: any) {
  const results = fixtures.map((f: any) => runIntegrationFixture(f))
  const passed = results.filter((r: any) => r.passed).length
  return { total: fixtures.length, passed, failed: fixtures.length - passed, results, summary: `${passed}/${fixtures.length} pass` }
}
