'use strict'
// realworld — 真实项目端到端 harness（基于 neutral + implemented 的最小可跑验证）

import { neutralToBlueprint } from '../perception/neutral-ingest.ts'
import { runIntegrationFixture } from './integration.ts'

export function validateRealWorld({ neutrals, implementeds }: any) {
  const results = []
  for (let i = 0; i < Math.min(neutrals.length, implementeds.length); i++) {
    const r = runIntegrationFixture({ neutral: neutrals[i], implementedTree: implementeds[i], expectedScore: 0.9 })
    results.push({ index: i, passed: r.passed, score: r.score.total })
  }
  const passed = results.filter(r => r.passed).length
  return { total: results.length, passed, failed: results.length - passed, results, summary: `${passed}/${results.length} realworld pass` }
}
