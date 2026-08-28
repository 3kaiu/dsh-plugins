'use strict'
// property — layout 的 property-based 检验（生成随机树，断言不变量）

export function genRandomTree(depth = 2, breadth = 3) {
  const id = () => `n-${Math.random().toString(36).slice(2,6)}`
  function gen(d) {
    if (d === 0) return { id: id(), name: 'leaf', rect: { x: Math.random()*100, y: Math.random()*100, w: 50+Math.random()*50, h: 20+Math.random()*20 }, children: [] }
    const children = Array.from({length: 1+Math.floor(Math.random()*breadth)}, () => gen(d-1))
    return { id: id(), name: 'container', rect: { x: 0, y: 0, w: 200, h: 200 }, children }
  }
  return [gen(depth)]
}

export function checkInvariant(tree) {
  // 不变量：所有节点 w/h >0，x/y 有限
  const violations = []
  function walk(nodes) {
    for (const n of nodes) {
      if (n.rect && (n.rect.w <= 0 || n.rect.h <= 0)) violations.push({ id: n.id, rule: 'positive-size' })
      if (n.rect && (!isFinite(n.rect.x) || !isFinite(n.rect.y))) violations.push({ id: n.id, rule: 'finite-pos' })
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree])
  return { passed: violations.length === 0, violations }
}
