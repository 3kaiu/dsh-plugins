'use strict'
// token-map — 设计令牌映射（blueprint typographyProfile/palette → 项目 tokens）
// 目标：Phase2 仓库映射时，优先复用项目已有 tokens（CSS 变量/Tailwind/设计系统），缺失再新建
// 输入：blueprint 的 typographyProfile/palette + 项目 tokens 清单（grep/glob 或 LSP 收集）
// 输出：映射表 {blueprintKey → {token, distance, action: reuse|create|near}}

import { comparePalette } from '../compare/palette.ts'

/**
 * 字体映射：按 family 完全匹配 > size/weight 近邻
 * @param blueprintProfile { 'header > title': {family,size,weight} }
 * @param projectTokens [{name, family, size, weight, cssVar}] 项目已有字体 tokens
 */
export function mapTypographyTokens(blueprintProfile: Record<string, any>, projectTokens: Record<string, any>[] = []) {
  const mappings = []
  for (const [path, spec] of Object.entries(blueprintProfile)) {
    const { family, size, weight } = spec
    let best = null, bestDist = Infinity
    for (const tok of projectTokens) {
      let dist = 0
      if (family && tok.family && family !== tok.family) dist += 10
      if (size != null && tok.size != null) dist += Math.abs(size - tok.size) * 0.5
      if (weight != null && tok.weight != null) dist += Math.abs(weight - tok.weight) / 100
      if (dist < bestDist) { bestDist = dist; best = tok }
    }
    if (best && bestDist < 5) {
      mappings.push({ path, blueprint: spec, token: best, distance: Math.round(bestDist*10)/10, action: bestDist === 0 ? 'reuse' : 'near', suggestion: bestDist === 0 ? `var(${best.cssVar || best.name})` : `near ${best.name} (Δ${bestDist})` })
    } else {
      mappings.push({ path, blueprint: spec, token: null, distance: null, action: 'create', suggestion: `create ${family || 'sans'} ${size || ''} ${weight || ''}`.trim() })
    }
  }
  return mappings
}

/**
 * 颜色映射：CIEDE2000 最近邻（复用 palette 的 ΔE）
 * @param blueprintPalette [{hex,count}] 来自 blueprint.palette
 * @param projectPalette ['#fff', '#000'] 项目已有色板
 * @param deltaEThreshold 3（doc13 色差阈值）
 */
export function mapPaletteTokens(blueprintPalette: any, projectPalette = [], deltaEThreshold = 3) {
  const projHex = projectPalette.map(c => typeof c === 'string' ? c : (c as any).hex)
  const mappings = []
  for (const bp of blueprintPalette) {
    const hex = (bp as any).hex || bp
    // 用 comparePalette 的 ΔE 计算最近
    let best = null, bestDeltaE = Infinity
    for (const ph of projHex) {
      try {
        const res: any = comparePalette({ referencePalette: [hex], implementedPalette: [ph], deltaEThreshold: 100 } as any)
        // comparePalette 返回 colors[0].deltaE（或 mismatches/extra 兼容）
        const dE = res.colors?.[0]?.deltaE ?? res.mismatches?.[0]?.deltaE ?? res.deltaE ?? 100
        const deltaE = typeof dE === 'number' ? dE : 100
        if (deltaE < bestDeltaE) { bestDeltaE = deltaE; best = ph }
        continue
      } catch {}
      // 备用：简单 hex 距离
      const dist = hexDistance(hex, ph)
      if (dist < bestDeltaE) { bestDeltaE = dist; best = ph }
    }
    if (best && bestDeltaE <= deltaEThreshold) {
      mappings.push({ blueprint: hex, token: best, deltaE: Math.round(bestDeltaE*10)/10, action: 'reuse', suggestion: best })
    } else if (best && bestDeltaE <= deltaEThreshold * 2) {
      mappings.push({ blueprint: hex, token: best, deltaE: Math.round(bestDeltaE*10)/10, action: 'near', suggestion: `near ${best} ΔE ${Math.round(bestDeltaE*10)/10}` })
    } else {
      mappings.push({ blueprint: hex, token: null, deltaE: bestDeltaE === Infinity ? null : Math.round(bestDeltaE*10)/10, action: 'create', suggestion: `create ${hex}` })
    }
  }
  return mappings
}

function hexDistance(a: any, b: any) {
  const pa = parseHex(a), pb = parseHex(b)
  if (!pa || !pb) return 100
  return Math.sqrt((pa.r-pb.r)**2 + (pa.g-pb.g)**2 + (pa.b-pb.b)**2) / 441.6 * 100 // 归一 0-100
}
function parseHex(hex: any) {
  if (!hex || typeof hex !== 'string') return null
  const h = hex.replace('#','')
  if (h.length === 3) return { r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16) }
  if (h.length === 6) return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) }
  return null
}
