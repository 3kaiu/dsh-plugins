'use strict'
// animation — 动效还原与校验（transition/animation 的提取与对比）

export function extractAnimations(tree: any) {
  const out = []
  function walk(nodes: any) {
    for (const n of nodes) {
      const anim = n.computed?.animation || n.effect?.animation || n.style?.animation
      const trans = n.computed?.transition || n.style?.transition
      if (anim || trans) out.push({ id: n.id || n.name, anim, trans, tag: n.tag })
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree])
  return out
}

export function compareAnimations(refAnims, implAnims, toleranceMs = 50) {
  const mismatches = []
  const refMap = new Map<any, any>(refAnims.map((a: any) => [a.id, a]))
  for (const impl of implAnims) {
    const ref = refMap.get(impl.id)
    if (!ref) continue
    // 简化：对比 duration（若有）
    const refDur = parseDuration(ref.anim || ref.trans)
    const implDur = parseDuration(impl.anim || impl.trans)
    if (refDur != null && implDur != null && Math.abs(refDur - implDur) > toleranceMs) {
      mismatches.push({ id: impl.id, prop: 'duration', expected: refDur, actual: implDur, delta: Math.abs(refDur - implDur) })
    }
  }
  return { mismatches, passed: mismatches.length === 0 }
}

function parseDuration(str: any) {
  if (!str || typeof str !== 'string') return null
  const m = str.match(/(\d+)(ms|s)/)
  if (!m) return null
  return m[2] === 's' ? parseInt(m[1],10)*1000 : parseInt(m[1],10)
}
