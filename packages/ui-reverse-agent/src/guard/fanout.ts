'use strict'
// Guard.Fanout — Phase5 单假设扇出评估（并行安全）
// 对同一差异的多个候选修复值做“树打补丁 → 重对比 → 预测 ΔS”排序，不改文件，纯测量
// 与 DSH 的 isConcurrencySafe 并行调度兼容：3 候选可安全并发

import { compareGeometry } from '../measure/geometry.ts'
import { scoreReport } from '../compare/score.ts'

export interface Mismatch {
  path: string
  prop: string
  expected: number
  actual: number
  delta?: number
  priority?: string
}

export interface FanoutCandidate {
  value: number | string
  label?: string // 人读标签，如 "gap 24px（期望值）"
  note?: string
}

export interface RankedCandidate extends FanoutCandidate {
  predictedTotal: number
  predictedDelta: number
  mismatchesAfter: number
  score: ReturnType<typeof scoreReport>
  rank: number
}

function cloneTree(tree) {
  return JSON.parse(JSON.stringify(tree))
}

function findNodeByPath(tree, path) {
  // path 如 "main > .card-grid" 按 ">" 切段，按 name/id 模糊匹配
  const segments = path.split('>').map(s => s.trim()).filter(Boolean)
  // 树可能是数组（多根）或单根
  const roots = Array.isArray(tree) ? tree : [tree]
  function search(nodes, segIdx) {
    if (segIdx >= segments.length) return null
    const seg = segments[segIdx]
    for (const n of nodes) {
      const name = (n.name || n.id || '').toString()
      // 兼容 .class 选择器：seg 去掉 '.' 后做 includes
      const segNorm = seg.replace(/^\./, '')
      const match = name === seg || name.includes(segNorm) || segNorm.includes(name)
      if (match) {
        if (segIdx === segments.length - 1) return n
        if (n.children?.length) {
          const deeper = search(n.children, segIdx + 1)
          if (deeper) return deeper
        }
      }
      // 兄弟分支继续，且向子树递归查找（容错：path 可能省略中间层）
      if (n.children?.length) {
        const deeper = search(n.children, segIdx)
        if (deeper && deeper !== n) return deeper
      }
    }
    return null
  }
  return search(roots, 0)
}

function patchNodeProp(tree, mismatch, candidateValue) {
  const cloned = cloneTree(tree)
  const node = findNodeByPath(cloned, mismatch.path)
  if (!node) return { tree: cloned, patched: false }
  // 常见 prop 映射到节点的 rect / computed / layout
  const prop = mismatch.prop
  // rect 相关：compareGeometry 输出 prop 为 x/y/width/height，需映射到 rect 的 x/y/w/h
  if (['width','height','x','y','w','h'].includes(prop)) {
    node.rect = node.rect || {}
    let key = prop
    if (prop === 'width') key = 'w'
    else if (prop === 'height') key = 'h'
    node.rect[key] = candidateValue
    // 兼容：同时写入常见别名，供不同管线读取
    if (key === 'w') { node.rect.width = candidateValue; node.rect.w = candidateValue }
    if (key === 'h') { node.rect.height = candidateValue; node.rect.h = candidateValue }
    if (key === 'x') node.rect.x = candidateValue
    if (key === 'y') node.rect.y = candidateValue
    // 同步 _x/_y/_width/_height 兼容
    if (key === 'x') node._x = candidateValue
    if (key === 'y') node._y = candidateValue
    if (key === 'w') node._width = candidateValue
    if (key === 'h') node._height = candidateValue
    return { tree: cloned, patched: true }
  }
  // gap/padding/margin 等布局属性
  node.computed = node.computed || {}
  node.computed[prop] = candidateValue
  node.layout = node.layout || {}
  node.layout[prop] = candidateValue
  return { tree: cloned, patched: true }
}

/**
 * 生成候选（若调用方未显式提供）
 * 策略：期望值本身 + 期望±1px（容差边界）共 3 个；若 prop 非数值则退化为单候选
 */
export function generateCandidates(mismatch, count = 3): FanoutCandidate[] {
  const exp = mismatch.expected
  if (typeof exp !== 'number') return [{ value: exp, label: String(exp) }]
  if (count <= 1) return [{ value: exp, label: `${mismatch.prop} ${exp}（期望值）` }]
  return [
    { value: exp, label: `${mismatch.prop} ${exp}（期望值）` },
    { value: exp + 1, label: `${mismatch.prop} ${exp + 1}（+1 容差）` },
    { value: exp - 1, label: `${mismatch.prop} ${exp - 1}（-1 容差）` },
  ].slice(0, count)
}

/**
 * 扇出评估核心：对同一 mismatch 的多个候选值，分别打补丁→重对比→评分，返回按 predictedTotal 降序
 * @param mismatch 单个差异（来自 compare_geometry/compare_layouts）
 * @param candidates 候选修复值（若为空则自动生成 3 个）
 * @param referenceTree 参考树（blueprint）
 * @param implementedTree 实现树（当前 DOM 树）
 * @param opts.tolerance 容差（默认 2）
 * @param opts.currentScore 当前总分（用于 computed delta）
 */
export function fanoutEvaluate({ mismatch, candidates, referenceTree, implementedTree, tolerance = 2, currentScore = null }) {
  if (!mismatch || !referenceTree || !implementedTree) {
    return { error: 'missing mismatch/referenceTree/implementedTree', ranked: [] }
  }
  const cands = (Array.isArray(candidates) && candidates.length > 0)
    ? candidates.map(c => typeof c === 'object' && c !== null && 'value' in c ? c : { value: c })
    : generateCandidates(mismatch, 3)

  // 基线：当前实现树的 mismatches（用于 delta）
  const baseline = compareGeometry({ referenceTree, implementedTree, tolerance })
  const baselineMismatches = baseline.mismatchedCount ?? baseline.mismatches?.length ?? 0

  const ranked: RankedCandidate[] = cands.map((cand) => {
    const { tree: patchedTree, patched } = patchNodeProp(implementedTree, mismatch, cand.value)
    const cmp = compareGeometry({ referenceTree, implementedTree: patchedTree, tolerance })
    const mismatchesAfter = cmp.mismatchedCount ?? cmp.mismatches?.length ?? 0
    // 用 mismatches 减少量估算几何层分：每消除 1 条 mismatch 几何分 +0.1（上限 1）
    const geomBefore = Math.max(0, 1 - baselineMismatches * 0.1)
    const geomAfter = Math.max(0, 1 - mismatchesAfter * 0.1)
    // 结构层假设不变，用 0.9 占位；其余三层沿用当前或 0.9
    const s = scoreReport({
      struct: 0.9,
      geom: geomAfter,
      pixel: 0.9,
      type: 0.9,
      color: 0.9,
      previousTotal: currentScore ?? undefined,
    })
    const predictedDelta = currentScore != null ? Math.round((s.total - currentScore) * 1000) / 1000 : 0
    return {
      value: cand.value,
      label: cand.label || String(cand.value),
      note: cand.note,
      patched,
      mismatchesAfter,
      baselineMismatches,
      mismatches: cmp.mismatches,
      geomBefore,
      geomAfter,
      predictedTotal: s.total,
      predictedDelta,
      score: s,
      rank: 0,
    }
  })

  // 按 predictedTotal 降序，其次 mismatchesAfter 升序，其次 value 接近 expected 优先
  ranked.sort((a, b) => {
    if (b.predictedTotal !== a.predictedTotal) return b.predictedTotal - a.predictedTotal
    if (a.mismatchesAfter !== b.mismatchesAfter) return a.mismatchesAfter - b.mismatchesAfter
    return Math.abs((a.value as number) - (mismatch.expected as number)) - Math.abs((b.value as number) - (mismatch.expected as number))
  })
  ranked.forEach((r, i) => (r.rank = i + 1))

  const best = ranked[0] || null
  return {
    mismatch,
    baselineMismatches,
    baselineScore: currentScore,
    candidates: cands,
    ranked,
    best,
    recommendation: best ? `采用 rank 1：${best.label}（预测总分 ${best.predictedTotal}，Δ ${best.predictedDelta >= 0 ? '+' : ''}${best.predictedDelta}）` : null,
  }
}
