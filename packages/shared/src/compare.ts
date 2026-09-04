'use strict'
// compare_layouts 最小版：参考树 vs 实现树 → 结构化差异列表
// 输入：两棵标注树（annotate_layout / domToLayout 输出的 tree 数组）
// 输出：{ matched, missing, extra, mismatches: [{path,prop,expected,actual,delta,priority,confidence}] }

function flatten(tree: any, parentPath: any = ''): any[] {
  const out: any[] = []
  const walk = (nodes: any, base: any) => {
    for (const n of nodes) {
      const path = base ? `${base} > ${n.name || n.id}` : (n.name || n.id)
      out.push({ node: n, path })
      if (n.children && n.children.length) walk(n.children, path)
    }
  }
  walk(tree, parentPath)
  return out
}

function layoutProps(layout: any) {
  if (!layout) return {}
  return {
    // core 蓝图无 flexDirection, 用 role 折叠(row/column); 其余 role 词汇(stack/box)不映射
    flexDirection: layout.flexDirection ?? (layout.role === 'row' ? 'row' : layout.role === 'column' ? 'column' : null) ?? null,
    gap: layout.gap ?? null,
    padding: layout.padding ?? null,
    alignItems: layout.alignItems ?? null,
    justifyContent: layout.justifyContent ?? null,
  }
}

function priorityForProp(prop: any) {
  if (prop === 'flexDirection' || prop === 'missing' || prop === 'extra') return 'P0'
  if (prop === 'gap' || prop === 'padding' || prop === 'alignItems' || prop === 'justifyContent') return 'P1'
  return 'P2'
}

function deltaValue(expected: any, actual: any) {
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual)
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const len = Math.max(expected.length, actual.length)
    let sum = 0
    for (let i = 0; i < len; i++) sum += Math.abs((expected[i] ?? 0) - (actual[i] ?? 0))
    return sum
  }
  return expected === actual ? 0 : 1
}

function scoreMatch(refNode: any, implNode: any) {
  let s = 0
  if (refNode.name && implNode.name && refNode.name === implNode.name) s += 10
  if (refNode.type && implNode.type && refNode.type === implNode.type) s += 2
  if (refNode.role && implNode.role && refNode.role === implNode.role) s += 5
  // bbox 距离惩罚
  const rb = refNode.rect || refNode.bbox || refNode.bounds || null
  const ib = implNode.rect || implNode.bbox || implNode.bounds || null
  if (rb && ib) {
    const dx = Math.abs((rb.x ?? 0) - (ib.x ?? 0))
    const dy = Math.abs((rb.y ?? 0) - (ib.y ?? 0))
    s -= (dx + dy) / 100
  }
  return s
}

export function compareLayouts({ referenceTree, implementedTree }: { referenceTree: any; implementedTree: any }) {
  const refFlat = flatten(Array.isArray(referenceTree) ? referenceTree : [referenceTree])
  const implFlat = flatten(Array.isArray(implementedTree) ? implementedTree : [implementedTree])

  const usedImpl = new Set()
  const mismatches = []
  const missing = []
  let matched = 0

  for (const { node: ref, path } of refFlat) {
    let best = null
    let bestScore = -Infinity
    let bestIdx = -1
    implFlat.forEach(({ node: impl }, idx) => {
      if (usedImpl.has(idx)) return
      const sc = scoreMatch(ref, impl)
      if (sc > bestScore) {
        bestScore = sc
        best = impl
        bestIdx = idx
      }
    })
    // 阈值：至少 name 或 role 匹配才算命中，否则视为 missing
    const isMatch = best && bestScore >= 5
    if (!isMatch) {
      missing.push({ path, priority: 'P0', reason: 'reference node not found in implemented tree' })
      continue
    }
    usedImpl.add(bestIdx)
    matched++

    // 逐属性比较
    const refL = layoutProps(ref.layout)
    const implL = layoutProps(best!.layout)
    for (const prop of ['flexDirection', 'gap', 'padding', 'alignItems', 'justifyContent'] as const) {
      const exp = (refL as any)[prop]
      const act = (implL as any)[prop]
      // 两边都 null 视为一致
      if (exp == null && act == null) continue
      const same = JSON.stringify(exp) === JSON.stringify(act)
      if (!same) {
        mismatches.push({
          path,
          prop,
          expected: exp,
          actual: act,
          delta: deltaValue(exp, act),
          priority: priorityForProp(prop),
          confidence: 0.9,
        })
      }
    }
  }

  const extra: any[] = []
  implFlat.forEach(({ node: impl, path }, idx) => {
    if (!usedImpl.has(idx)) extra.push({ path, priority: 'P2', reason: 'implemented node not in reference' })
  })

  return { matched, missing, extra, mismatches }
}
