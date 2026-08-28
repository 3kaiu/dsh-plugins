'use strict'
// design-constraints — 设计系统约束校验（Phase5 实现前的守卫，与 anti_hack_scan 互补）
// 输入：候选修改 {prop, value, path} + 项目约束 {spacingScale, colorPalette, typographyScale}
// 输出：{passed, violations, warnings, suggestion} — 阻止“任意值”破坏 Design System
import { runtimeConfig } from '../config.ts'

export interface DesignConstraints {
  spacingScale?: number[] // 如 [0,4,8,16,24,32,48,64]，空则不校验
  colorPalette?: string[] // 项目允许色板 hex，如 ['#111','#fff','#0052cc']
  typographyScale?: { sizes?: number[], weights?: number[], families?: string[] }
  borderRadiusScale?: number[] // 如 [0,4,8,12,16]
}

export function checkDesignConstraints({ prop, value, path }, constraints: DesignConstraints = {}) {
  const violations = []
  const warnings = []

  // 1. Spacing 约束（gap/padding/margin/width/height 的数值应命中 scale）
  const spacingProps = ['gap', 'padding', 'margin', 'width', 'height', 'x', 'y', 'top', 'left', 'right', 'bottom', 'rowGap', 'columnGap']
  if (spacingProps.includes(prop) && typeof value === 'number' && Array.isArray(constraints.spacingScale) && constraints.spacingScale.length) {
    const scale = constraints.spacingScale
    const nearest = scale.reduce((a, b) => Math.abs(b - value) < Math.abs(a - value) ? b : a, scale[0])
    const dist = Math.abs(value - nearest)
    if (dist > runtimeConfig.tol) { // 容差（config.tol，默认 2px）
      violations.push({ rule: 'spacing-scale', prop, value, nearest, dist, path, reason: `值 ${value} 未命中 spacingScale，近邻 ${nearest} 距 ${dist}px` })
    } else if (dist > 0) {
      warnings.push({ rule: 'spacing-scale', prop, value, nearest, dist, path, reason: `近邻 ${nearest} 更贴合 scale` })
    }
  }

  // 2. Color 约束（color/backgroundColor/borderColor 应来自 palette 或 ΔE 近邻）
  const colorProps = ['color', 'backgroundColor', 'borderColor', 'fill', 'background']
  if (colorProps.includes(prop) && typeof value === 'string' && value.startsWith('#') && Array.isArray(constraints.colorPalette) && constraints.colorPalette.length) {
    const palette = constraints.colorPalette.map(c => c.toLowerCase())
    if (!palette.includes(value.toLowerCase())) {
      // 非精确命中视为 warning（允许近邻，anti_hack 已拦背景图冒充）
      warnings.push({ rule: 'color-palette', prop, value, palette, reason: `色值 ${value} 非 palette 精确命中，建议复用 ${palette.slice(0,3).join(',')} 近邻` })
    }
  }

  // 3. Typography 约束（fontSize/weight/family 应来自 scale）
  if ((prop === 'fontSize' || prop === 'size') && typeof value === 'number' && constraints.typographyScale?.sizes?.length) {
    const scale = constraints.typographyScale.sizes
    const nearest = scale.reduce((a, b) => Math.abs(b - value) < Math.abs(a - value) ? b : a, scale[0])
    if (Math.abs(value - nearest) > 1) {
      violations.push({ rule: 'typography-size', prop, value, nearest, reason: `字号 ${value} 未命中 typeScale，近邻 ${nearest}` })
    }
  }
  if ((prop === 'fontWeight' || prop === 'weight') && typeof value === 'number' && constraints.typographyScale?.weights?.length) {
    if (!constraints.typographyScale.weights.includes(value)) {
      warnings.push({ rule: 'typography-weight', prop, value, allowed: constraints.typographyScale.weights, reason: `字重 ${value} 非 scale ${constraints.typographyScale.weights.join(',')}` })
    }
  }
  if ((prop === 'fontFamily' || prop === 'family') && typeof value === 'string' && constraints.typographyScale?.families?.length) {
    if (!constraints.typographyScale.families.includes(value)) {
      warnings.push({ rule: 'typography-family', prop, value, allowed: constraints.typographyScale.families, reason: `字体 ${value} 非 families` })
    }
  }

  // 4. Radius 约束
  if (prop === 'borderRadius' && typeof value === 'number' && Array.isArray(constraints.borderRadiusScale) && constraints.borderRadiusScale.length) {
    const nearest = constraints.borderRadiusScale.reduce((a, b) => Math.abs(b - value) < Math.abs(a - value) ? b : a, constraints.borderRadiusScale[0])
    if (Math.abs(value - nearest) > 2) {
      warnings.push({ rule: 'radius-scale', prop, value, nearest, reason: `圆角 ${value} 非 scale，近邻 ${nearest}` })
    }
  }

  const passed = violations.length === 0
  return {
    passed,
    violations,
    warnings,
    summary: passed ? (warnings.length ? `warnings: ${warnings.length}` : 'pass') : `violations: ${violations.map(v=>v.rule).join(',')}`,
    suggestion: !passed ? `建议改 ${violations[0].nearest}（scale 近邻）` : warnings.length ? `可优化为 ${warnings[0].nearest || warnings[0].palette?.[0]}` : null,
  }
}

/**
 * 批量校验（Phase5 扇出后，对 ranked 候选做约束过滤）
 * @param ranked 来自 fanoutEvaluate 的 ranked 列表
 * @param constraints 项目约束
 * @returns {filtered, blocked} filtered 为通过约束的候选（按原 rank 保序）
 */
export function filterByConstraints(ranked, constraints) {
  const filtered = []
  const blocked = []
  for (const r of ranked) {
    // 需从 ranked 的 mismatch 推断 prop（fanout 的 mismatch.path/prop）
    // 这里简化：取 r.value 对应的 prop（调用方需补充）
    // 本函数要求 ranked 项含 _mismatch 字段（由调用方注入）
    const prop = r._prop || r.prop || 'gap'
    const res = checkDesignConstraints({ prop, value: r.value, path: r.path || '' }, constraints)
    if (res.passed) filtered.push({ ...r, constraint: res })
    else blocked.push({ ...r, constraint: res })
  }
  return { filtered, blocked, allPassed: blocked.length === 0 }
}
