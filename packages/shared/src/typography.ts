'use strict'
// compare_typography：实现侧文字度量 vs 排版档案 → 逐项偏差
// 输入：referenceTree / implementedTree（标注树或 DOM 树），或直接的 profile 数组
// 排版档案形态：{ typographyProfile: { heading:{family,size,weight,lineHeight,letterSpacing,color}, body:{...} } }
// 但最通用的输入是两棵树，自动提取文本节点的排版属性后逐对比较

function flatten(tree: any, parentPath: any = '') {
  const out: any[] = []
  const walk = (nodes: any, base: any) => {
    for (const n of nodes) {
      const path = base ? `${base} > ${n.name || n.id}` : (n.name || n.id)
      out.push({ node: n, path })
      if (n.children && n.children.length) walk(n.children, path)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree], parentPath)
  return out
}

function getTypography(n: any) {
  // 优先 computed，其次 font / textColor 等 DSL 字段
  const comp = n.computed || {}
  const font = n.font || {}
  // 参考侧可能存放在 node.font / node.textColor / node._color / n.text 等
  const family = comp.fontFamily || font.family || font.fontFamily || null
  const sizeRaw = comp.fontSize ?? font.size ?? font.fontSize ?? null
  const size = sizeRaw != null ? parseFloat(String(sizeRaw)) : null
  const weightRaw = comp.fontWeight ?? font.weight ?? null
  const weight = weightRaw != null ? String(weightRaw) : null
  const lhRaw = comp.lineHeight ?? font.lineHeight ?? null
  const lineHeight = lhRaw != null ? parseFloat(String(lhRaw)) : null
  const lsRaw = comp.letterSpacing ?? font.letterSpacing ?? null
  const letterSpacing = lsRaw != null ? parseFloat(String(lsRaw)) : null
  const color = comp.color || n.textColor || n._color || null
  const text = (n.text || (Array.isArray(n.rowTexts) ? n.rowTexts.map((t: any) => typeof t === 'string' ? t : t.text).join('') : '') || '').trim()
  return { family, size, weight, lineHeight, letterSpacing, color, text }
}

function isTextNode(n: any) {
  const t = getTypography(n)
  if (t.text) return true
  if (n.type === 'TEXT') return true
  if (n.role === 'text') return true
  return false
}

function scoreMatch(refNode: any, implNode: any) {
  let s = 0
  if (refNode.name && implNode.name && refNode.name === implNode.name) s += 10
  const rt = getTypography(refNode).text
  const it = getTypography(implNode).text
  if (rt && it && rt === it) s += 8
  if (refNode.selector && implNode.selector && refNode.selector === implNode.selector) s += 8
  if (refNode.type && implNode.type && refNode.type === implNode.type) s += 1
  return s
}

function normalizeWeight(w: any) {
  if (w == null) return null
  const map: Record<string, number> = { thin: 100, extralight: 200, light: 300, regular: 400, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 }
  const key = String(w).toLowerCase().trim()
  if (map[key] != null) return map[key]
  const n = parseInt(key, 10)
  return Number.isFinite(n) ? n : null
}

function colorDelta(c1: any, c2: any) {
  if (!c1 || !c2) return null
  if (String(c1).toLowerCase() === String(c2).toLowerCase()) return 0
  return 1 // 颜色不等记 1，后续 palette 层用 ΔE 精算
}

export function compareTypography({ referenceTree, implementedTree, referenceProfile, implementedMetrics }: any) {
  // 支持两种输入：树 vs 树，或 profile vs metrics
  if (referenceProfile || implementedMetrics) {
    // profile 模式：直接对比档案（简化）
    const mismatches = []
    const ref = referenceProfile || {}
    const impl = implementedMetrics || {}
    for (const key of Object.keys(ref)) {
      const e = ref[key], a = impl[key]
      if (!a) { mismatches.push({ path: key, prop: 'missing', expected: e, actual: null, priority: 'P1' }); continue }
      const sizeDelta = e.size != null && a.size != null ? Math.abs(e.size - a.size) : 0
      if (sizeDelta > 1) mismatches.push({ path: key, prop: 'fontSize', expected: e.size, actual: a.size, delta: sizeDelta, priority: 'P1' })
      const lhDelta = e.lineHeight != null && a.lineHeight != null ? Math.abs(e.lineHeight - a.lineHeight) : 0
      if (lhDelta > 1) mismatches.push({ path: key, prop: 'lineHeight', expected: e.lineHeight, actual: a.lineHeight, delta: lhDelta, priority: 'P2' })
      const w1 = normalizeWeight(e.weight), w2 = normalizeWeight(a.weight)
      if (w1 != null && w2 != null && Math.abs(w1 - w2) > 100) mismatches.push({ path: key, prop: 'fontWeight', expected: w1, actual: w2, delta: Math.abs(w1-w2), priority: 'P1' })
    }
    return { mismatches, stats: { total: Object.keys(ref).length, mismatched: mismatches.length } }
  }

  const refFlat = flatten(Array.isArray(referenceTree) ? referenceTree : [referenceTree]).filter(({ node }) => isTextNode(node))
  const implFlat = flatten(Array.isArray(implementedTree) ? implementedTree : [implementedTree]).filter(({ node }) => isTextNode(node))

  // 若参考侧无显式文本节点（如测试 fixture），回退到直接按索引对齐？
  const used = new Set()
  const mismatches = []

  for (const { node: ref, path } of refFlat) {
    let best = null, bestScore = -Infinity, bestIdx = -1
    implFlat.forEach(({ node: impl }, idx) => {
      if (used.has(idx)) return
      const sc = scoreMatch(ref, impl)
      if (sc > bestScore) { bestScore = sc; best = impl; bestIdx = idx }
    })
    if (!best || bestScore < 4) {
      // 文本缺失：记为 missing
      mismatches.push({ path, prop: 'missing', expected: getTypography(ref).text || '(text)', actual: null, priority: 'P1', reason: 'text node not found in implemented tree' })
      continue
    }
    used.add(bestIdx)
    const e = getTypography(ref)
    const a = getTypography(best)

    if (e.size != null && a.size != null) {
      const d = Math.abs(e.size - a.size)
      if (d > 1) mismatches.push({ path, prop: 'fontSize', expected: e.size, actual: a.size, delta: Math.round(d*10)/10, priority: 'P1', confidence: 0.9 })
    }
    const w1 = normalizeWeight(e.weight), w2 = normalizeWeight(a.weight)
    if (w1 != null && w2 != null && Math.abs(w1 - w2) > 100) {
      mismatches.push({ path, prop: 'fontWeight', expected: w1, actual: w2, delta: Math.abs(w1 - w2), priority: 'P1' })
    }
    if (e.lineHeight != null && a.lineHeight != null) {
      const d = Math.abs(e.lineHeight - a.lineHeight)
      if (d > 1) mismatches.push({ path, prop: 'lineHeight', expected: e.lineHeight, actual: a.lineHeight, delta: Math.round(d*10)/10, priority: 'P2' })
    }
    if (e.letterSpacing != null && a.letterSpacing != null) {
      const d = Math.abs(e.letterSpacing - a.letterSpacing)
      if (d > 0.5) mismatches.push({ path, prop: 'letterSpacing', expected: e.letterSpacing, actual: a.letterSpacing, delta: Math.round(d*10)/10, priority: 'P3' })
    }
    if (e.family && a.family && String(e.family).toLowerCase() !== String(a.family).toLowerCase()) {
      // 字体族不等：记为 mismatch，但若为系统回退可降级（此处直接报）
      mismatches.push({ path, prop: 'fontFamily', expected: e.family, actual: a.family, priority: 'P1' })
    }
    if (e.color && a.color && String(e.color).toLowerCase() !== String(a.color).toLowerCase()) {
      mismatches.push({ path, prop: 'color', expected: e.color, actual: a.color, priority: 'P2' })
    }
  }

  // 实现侧多余文本节点（extra）不算排版错误，仅 extra 提示
  const extra: any[] = []
  implFlat.forEach(({ path }, idx) => { if (!used.has(idx)) extra.push({ path, priority: 'P3' }) })

  return { mismatches: mismatches.sort((a,b) => (a.priority||'').localeCompare(b.priority||'')), extra, stats: { referenceTextNodes: refFlat.length, implementedTextNodes: implFlat.length, mismatched: mismatches.length } }
}
