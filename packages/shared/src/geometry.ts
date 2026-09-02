'use strict'
// compare_geometry：蓝图 regions / 参考树 vs 实现树 → 几何偏差(px)
// 输入：两棵标注树（annotate_layout / page_layout_tree 的 tree）
// 输出：{ mismatches: [{path, prop, expected, actual, delta, priority}], stats: {meanDelta, maxDelta, mismatchedCount} }

function flatten(tree: any, parentPath: any = '') {
  const out = []
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

function getBbox(n: any) {
  // 支持多种来源：rect / bbox / layoutStyle
  if (n.rect) return { x: n.rect.x ?? 0, y: n.rect.y ?? 0, w: n.rect.w ?? n.rect.width ?? 0, h: n.rect.h ?? n.rect.height ?? 0 }
  if (n.bbox) return { x: n.bbox.x ?? 0, y: n.bbox.y ?? 0, w: n.bbox.width ?? n.bbox.w ?? 0, h: n.bbox.height ?? n.bbox.h ?? 0 }
  const ls = n.layoutStyle
  if (ls) return { x: ls.relativeX ?? 0, y: ls.relativeY ?? 0, w: ls.width ?? 0, h: ls.height ?? 0 }
  return null
}

function scoreMatch(refNode: any, implNode: any) {
  let s = 0
  if (refNode.name && implNode.name && refNode.name === implNode.name) s += 10
  if (refNode.type && implNode.type && refNode.type === implNode.type) s += 2
  if (refNode.role && implNode.role && refNode.role === implNode.role) s += 5
  if (refNode.selector && implNode.selector && refNode.selector === implNode.selector) s += 8
  const rb = getBbox(refNode)
  const ib = getBbox(implNode)
  if (rb && ib) {
    const dx = Math.abs((rb.x ?? 0) - (ib.x ?? 0))
    const dy = Math.abs((rb.y ?? 0) - (ib.y ?? 0))
    s -= (dx + dy) / 100
  }
  return s
}

export function compareGeometry({ referenceTree, implementedTree, tolerance = 2 }) {
  const refFlat = flatten(Array.isArray(referenceTree) ? referenceTree : [referenceTree])
  const implFlat = flatten(Array.isArray(implementedTree) ? implementedTree : [implementedTree])

  const used = new Set()
  const mismatches = []
  let matched = 0
  let totalDelta = 0
  let maxDelta = 0

  for (const { node: ref, path } of refFlat) {
    let best = null, bestScore = -Infinity, bestIdx = -1
    implFlat.forEach(({ node: impl }, idx) => {
      if (used.has(idx)) return
      const sc = scoreMatch(ref, impl)
      if (sc > bestScore) { bestScore = sc; best = impl; bestIdx = idx }
    })
    if (!best || bestScore < 5) continue
    used.add(bestIdx)
    matched++
    const rb = getBbox(ref)
    const ib = getBbox(best)
    if (!rb || !ib) continue
    const props = [
      { prop: 'x', expected: rb.x, actual: ib.x },
      { prop: 'y', expected: rb.y, actual: ib.y },
      { prop: 'width', expected: rb.w, actual: ib.w },
      { prop: 'height', expected: rb.h, actual: ib.h },
    ]
    for (const { prop, expected, actual } of props) {
      const delta = Math.abs((expected ?? 0) - (actual ?? 0))
      if (delta > tolerance) {
        mismatches.push({ path, prop, expected, actual, delta: Math.round(delta * 10) / 10, priority: prop === 'x' || prop === 'y' ? 'P1' : 'P1', tolerance })
        totalDelta += delta
        if (delta > maxDelta) maxDelta = delta
      }
    }
    // bbox 整体偏差（用于排序）
    const bboxDelta = Math.max(...props.map(p => Math.abs((p.expected ?? 0) - (p.actual ?? 0))))
    if (bboxDelta > maxDelta) maxDelta = bboxDelta
  }

  const mismatchedCount = mismatches.length
  const meanDelta = mismatchedCount ? Math.round((totalDelta / mismatchedCount) * 10) / 10 : 0
  return { matched, mismatchedCount, mismatches: mismatches.sort((a, b) => b.delta - a.delta), stats: { meanDelta, maxDelta: Math.round(maxDelta * 10) / 10 } }
}
