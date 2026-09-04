'use strict'
// ci — CI 确定性验证（artifacts 归档/报告/阈值门禁）
// 输入：scores/history + artifacts，输出：CI 报告与门禁判定

import fs from 'node:fs'
import path from 'node:path'
import { runtimeConfig } from '../config.ts'

export function buildCiReport({ state, blueprint, artifacts = [] }: Record<string, any> = {}) {
  const scores = state?.scores || {}
  const total = scores.current?.total ?? 0
  const threshold = runtimeConfig.completeThreshold
  const blocked = state?.antiHack?.violations?.length > 0 || false
  const hasP0 = (state?.remainingDifferences || []).some((d: any) => d.priority === 'P0')
  // core 蓝图四闸（meta.gates：contract/geometry/style/truth）：任一 FAIL = 蓝图失真，CI 直接不通过
  const gates = blueprint?.meta?.gates || null
  const gateFails: string[] = gates
    ? Object.entries(gates).filter(([, verdict]) => typeof verdict === 'string' && String(verdict).startsWith('FAIL')).map(([g, verdict]) => `${g}=${verdict}`)
    : []
  const passed = total >= threshold && !blocked && !hasP0 && gateFails.length === 0
  const failBits = [
    ...(total < threshold ? [`S ${total} < ${threshold}`] : []),
    ...(blocked ? ['blocked'] : []),
    ...(hasP0 ? ['has P0'] : []),
    ...(gateFails.length ? [`gates ${gateFails.join(', ')}`] : []),
  ]

  const report = {
    version: 1,
    at: new Date().toISOString(),
    passed,
    total,
    threshold,
    blocked,
    hasP0,
    ...(gates ? { gates } : {}),
    ...(gateFails.length ? { gateFails } : {}),
    remaining: state?.remainingDifferences?.length ?? 0,
    resolved: state?.resolvedDifferences?.length ?? 0,
    iteration: state?.iteration ?? 0,
    layers: scores.current || {},
    delta: scores.delta ?? 0,
    artifacts: artifacts.map((a: any) => typeof a === 'string' ? a : a.path || a.file),
    summary: passed ? `CI pass S ${total} ≥ ${threshold}` : `CI fail: ${failBits.join(', ')}`,
  }
  return report
}

export function writeCiArtifacts(report: any, { outDir = '.ui-reverse/ci' }: Record<string, any> = {}) {
  try {
    fs.mkdirSync(outDir, { recursive: true })
    const reportPath = path.join(outDir, 'report.json')
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    const md = [
      `# UI Reverse CI Report`,
      ``,
      `- Result: ${report.passed ? '✅ PASS' : '❌ FAIL'} — ${report.summary}`,
      `- Iteration: ${report.iteration}, Total: ${report.total}, Threshold: ${report.threshold}`,
      `- Remaining: ${report.remaining}, Resolved: ${report.resolved}, Blocked: ${report.blocked}, Has P0: ${report.hasP0}`,
      ...(report.gates ? [`- Gates: ${JSON.stringify(report.gates)}`] : []),
      `- Layers: ${JSON.stringify(report.layers)}`,
    ].join('\n')
    fs.writeFileSync(path.join(outDir, 'report.md'), md)
    return { reportPath, mdPath: path.join(outDir, 'report.md') }
  } catch (e) {
    return { error: String(e) }
  }
}

export function ciGate(report: any, { threshold = runtimeConfig.completeThreshold, allowBlocked = false, allowP0 = false }: Record<string, any> = {}) {
  if (!allowBlocked && report.blocked) return { pass: false, reason: 'blocked by anti_hack' }
  if (!allowP0 && report.hasP0) return { pass: false, reason: 'has P0 remaining' }
  // core 四闸 FAIL 不可豁免（蓝图失真即失真，无 allow 逃生口）
  if (Array.isArray(report.gateFails) && report.gateFails.length > 0) {
    return { pass: false, reason: `blueprint gates FAIL: ${report.gateFails.join(', ')}` }
  }
  if (report.total < threshold) return { pass: false, reason: `S ${report.total} < ${threshold}` }
  return { pass: true, reason: 'all gates pass' }
}
