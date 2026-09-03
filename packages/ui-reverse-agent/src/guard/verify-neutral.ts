'use strict'
// verify-neutral — 融合 doc14 §5 确定性验证与 ui-reverse Phase6 验证
// 输入：neutralTree（或 blueprint）+ 实现侧 DOM dump / 截图采样
// 输出：与 anti_hack_scan 互补的确定性断言（几何/文本命中/溢出/重叠/样式探针）

export function verifyNeutral({ neutral, blueprint, domDump = null, implementedTree, tolerance = 2 }) {
  const root = neutral?.root || blueprint?.tree && { children: blueprint.tree } || null
  const canvas = neutral?.meta?.canvas || blueprint?.canvas || { width: 1440, height: 900 }
  const violations = []
  const warnings = []

  // 1. 坐标系：以 #canvas 为原点（doc14 §5），此处用 neutral 的 x/y 已为页面坐标，需与 domDump/implementedTree 的 rect 对比
  if ((domDump?.tree || implementedTree) && root) {
    const neutralNodes = flattenNeutral(root)
    const implNodes = flattenImpl(implementedTree || domDump.tree)
    for (const nn of neutralNodes.slice(0, 20)) { // 抽样前20关键节点
      const impl = findClosestByName(implNodes, nn.name)
      if (!impl) {
        violations.push({ rule: 'missing-node', path: nn.name, reason: '实现侧未找到对应节点' })
        continue
      }
      const dx = Math.abs((nn.x ?? 0) - (impl.rect?.x ?? impl.bbox?.x ?? 0))
      const dy = Math.abs((nn.y ?? 0) - (impl.rect?.y ?? impl.bbox?.y ?? 0))
      if (dx > tolerance + 1 || dy > tolerance + 1) {
        violations.push({ rule: 'geometry', path: nn.name, expected: { x: nn.x, y: nn.y }, actual: { x: impl.rect?.x, y: impl.rect?.y }, delta: { x: dx, y: dy } })
      }
    }
  }

  // 2. 文本命中（TreeWalker 语义）：中立树 text 需在实现侧命中
  if (root && (domDump || implementedTree)) {
    const texts = collectTexts(root)
    const implTexts = collectImplTexts(implementedTree || domDump.tree)
    for (const t of texts.slice(0, 30)) {
      if (!t || t.length < 2) continue
      const norm = t.trim()
      if (norm.length < 2) continue
      const hit = implTexts.some(it => it.includes(norm) || norm.includes(it))
      if (!hit) {
        // 忽略占位符（doc14：_placeholder 是动态位）
        warnings.push({ rule: 'text-miss', text: norm.slice(0, 32), reason: '实现侧未命中文本（可能为动态数据位）' })
      }
    }
  }

  // 3. 溢出扫描：文本叶子 scrollWidth > clientWidth +3
  if (domDump?.tree || implementedTree) {
    const overflow = scanOverflow(domDump?.tree || implementedTree)
    for (const o of overflow) warnings.push({ rule: 'overflow', path: o.path, rect: o.rect, reason: '文本溢出 >3px，需 nowrap/pre' })
  }

  // 4. 重叠检测：不同内容叶子 bbox 交叠 >25%
  if (domDump?.tree || implementedTree) {
    const overlaps = scanOverlap(domDump?.tree || implementedTree)
    for (const o of overlaps.slice(0, 5)) violations.push({ rule: 'overlap', a: o.a, b: o.b, ratio: o.ratio, reason: '不同内容重叠 >25%' })
  }

  // 5. 样式探针：渐变 clip/text、背景透明等（抽样）
  if (neutral && implementedTree) {
    // 中立树含 gradient 的 text 应为 background-clip:text，暂以存在性检查
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
    summary: violations.length ? `violations: ${violations.map(v=>v.rule).join(',')}` : warnings.length ? `warnings: ${warnings.length}` : 'clean',
    canvas,
  }
}

function flattenNeutral(root: any) {
  const out = []
  function walk(n: any) {
    out.push(n)
    if (n.children) for (const c of n.children) walk(c)
  }
  if (Array.isArray(root.children)) for (const c of root.children) walk(c)
  else walk(root)
  return out
}
function flattenImpl(tree: any) {
  const out = []
  function walk(nodes: any) {
    for (const n of nodes) {
      out.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree])
  return out
}
function findClosestByName(nodes: any, name: any) {
  if (!name) return null
  return nodes.find((n: any) => (n.name || n.id) === name) || nodes.find((n: any) => (n.name || '').includes(name) || name.includes(n.name || '')) || null
}
function collectTexts(root: any) {
  const out = []
  function walk(n: any) {
    if (n.text) out.push(n.text)
    if (n.children) for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}
function collectImplTexts(tree: any) {
  const out = []
  function walk(nodes: any) {
    for (const n of nodes) {
      if (n.text) out.push(n.text)
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree])
  return out
}
function scanOverflow(tree: any) {
  const out = []
  function walk(nodes: any, base: any) {
    for (const n of nodes) {
      const path = base ? `${base} > ${n.name||n.id}` : (n.name||n.id)
      const rect = n.rect || n.bbox
      if (rect && n.text && n.scrollWidth) {
        if (n.scrollWidth > (rect.w ?? rect.width ?? 0) + 3) out.push({ path, rect })
      }
      if (n.children) walk(n.children, path)
    }
  }
  walk(Array.isArray(tree)?tree:[tree], '')
  return out
}
function scanOverlap(tree: any) {
  const leaves = []
  function walk(nodes: any) {
    for (const n of nodes) {
      if (!n.children?.length && n.rect) leaves.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree)?tree:[tree])
  const out = []
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j]
      if (a.text && b.text && a.text === b.text) continue // 父子包含误报过滤简化
      const ra = a.rect, rb = b.rect
      const interW = Math.max(0, Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x))
      const interH = Math.max(0, Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y))
      const inter = interW * interH
      const minArea = Math.min(ra.w * ra.h, rb.w * rb.h)
      if (minArea > 0 && inter / minArea > 0.25) out.push({ a: a.name||a.id, b: b.name||b.id, ratio: Math.round(inter/minArea*100)/100 })
    }
  }
  return out
}
