'use strict'
// dom-to-layout: browser_dom_dump → 标准 DSL 树（与 annotate_layout 同构）
// 输入: domDump = { viewport:{width,height}, tree:[{id,tag,selector,role,rect:{x,y,w,h},text,visible,children,computed:{display,flexDirection,gap,padding,position,font*,color,...}}] }
// 信号分级（与 MasterGo 相反）：computed 直读（conf 1.0） > 几何反推（0.7-0.95） > 降级 absolute（0.4）
// DOM 自带层级，无需容器吸收/带状聚类，只需按树聚合 + 每容器 computed 直读或 inferLayout 几何验证
import { inferLayout } from './layout-core.ts'

function parsePx(v) {
  if (v == null) return null
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

// "12px" | "12px 24px" | "12px 24px 12px 24px" -> [top,right,bottom,left]
function parsePadding(pad) {
  if (!pad) return null
  const parts = String(pad).trim().split(/\s+/).map(parsePx).filter(n => n != null)
  if (parts.length === 0) return null
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]]
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]]
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]]
  return [parts[0], parts[1], parts[2], parts[3]]
}

function parseGap(gap) {
  if (gap == null) return null
  // gap may be "8px" or "8px 16px" (row-gap column-gap)
  const parts = String(gap).trim().split(/\s+/).map(parsePx).filter(n => n != null)
  if (parts.length === 0) return null
  return parts[0]
}

function isVisibleNode(n) {
  if (n.visible === false) return false
  const r = n.rect
  if (!r) return false
  if ((r.w ?? r.width ?? 0) <= 0 || (r.h ?? r.height ?? 0) <= 0) return false
  const disp = n.computed?.display
  if (disp === 'none') return false
  return true
}

function suggestName(node, inferred) {
  const text = node.text?.trim()?.slice(0, 24)
  if (text) return text
  if (inferred?.position === 'absolute') return 'absolute-layer'
  if (inferred?.flexDirection === 'row') return 'row-group'
  if (inferred?.flexDirection === 'column') return 'column-group'
  return node.tag || node.role || 'layer'
}

function domNodeToInternal(node, parentRect, tolerance, counter = { n: 0 }) {
  const rect = node.rect || {}
  const x = (rect.x ?? rect.left ?? 0) - (parentRect ? (parentRect.x ?? 0) : 0)
  const y = (rect.y ?? rect.top ?? 0) - (parentRect ? (parentRect.y ?? 0) : 0)
  const w = rect.w ?? rect.width ?? 0
  const h = rect.h ?? rect.height ?? 0
  const filteredChildren = (node.children || []).filter(isVisibleNode)
  // 递归
  const internalChildren = filteredChildren.map(c => domNodeToInternal(c, rect, tolerance, counter))
  // computed 直读
  const comp = node.computed || {}
  let layout = null
  let suggestedName = node.tag || node.id || 'layer'
  if (internalChildren.length > 0) {
    const isFlex = comp.display === 'flex' || comp.display === 'inline-flex'
    const isGrid = comp.display === 'grid' || comp.display === 'inline-grid'
    // 优先 computed 直读
    if ((isFlex && comp.flexDirection) || isGrid) {
      const gap = parseGap(comp.gap ?? comp.gridGap ?? comp.columnGap)
      const padding = parsePadding(comp.padding)
      // 对齐直读
      const alignMap = { 'flex-start': 'start', center: 'center', 'flex-end': 'end' }
      const alignItems = comp.alignItems ? (alignMap[comp.alignItems] ?? comp.alignItems) : null
      const justifyContent = comp.justifyContent ?? null
      layout = {
        position: 'flex',
        flexDirection: isGrid ? 'row' : (comp.flexDirection || 'row'),
        flexWrap: comp.flexWrap ?? null,
        gap: gap ?? null,
        padding: padding ?? null,
        alignItems: alignItems,
        justifyContent: justifyContent,
        mainSizing: null,
        crossSizing: null,
        confidence: 1,
        absolutes: [],
        source: 'computed',
      }
      suggestedName = suggestName(node, layout)
    } else {
      // 几何反推
      const kidsForInfer = internalChildren.map(c => ({
        id: c.id,
        x: c.rectRelative.x,
        y: c.rectRelative.y,
        width: c.rectAbsolute.w,
        height: c.rectAbsolute.h,
        rotation: 0,
      }))
      const inferred = inferLayout({ container: { width: w, height: h }, children: kidsForInfer, tolerance })
      layout = { ...inferred, source: 'inferred' }
      suggestedName = suggestName(node, inferred)
    }
  }
  return {
    // 确定性 id：同一 DOM 两次 dump 产出一致（Math.random 会破坏跨 dump 的 id 配对/缓存与回归对比）
    id: node.id || node.selector || `dom:${(counter.n += 1).toString(36)}`,
    name: node.tag || node.role || node.id || 'layer',
    type: (node.tag || 'DIV').toUpperCase(),
    selector: node.selector || '',
    role: node.role || '',
    text: node.text || '',
    rectAbsolute: { x: rect.x ?? 0, y: rect.y ?? 0, w, h },
    rectRelative: { x, y, w, h },
    layout,
    suggestedName,
    computed: comp,
    children: internalChildren,
  }
}

function buildTree(domDump, tolerance) {
  const viewport = domDump.viewport || { width: 1440, height: 900 }
  const roots = Array.isArray(domDump.tree) ? domDump.tree : Array.isArray(domDump) ? domDump : [domDump]
  const visibleRoots = roots.filter(isVisibleNode)
  const tree = visibleRoots.map(n => domNodeToInternal(n, null, tolerance))
  // stats
  let total = 0, containers = 0, flex = 0, absolute = 0
  const walk = (nodes) => {
    for (const n of nodes) {
      total++
      if (n.children && n.children.length > 0) {
        containers++
        if (n.layout?.position === 'flex') flex++
        else absolute++
      }
      if (n.children) walk(n.children)
    }
  }
  walk(tree)
  return { canvas: viewport, tree, stats: { total, containers, flex, absolute } }
}

// 对外：输入 domDump，输出与 annotate_layout 同构的标注树
export function domToLayout(domDump, opts = {}) {
  const tolerance = opts.tolerance ?? 2
  const result = buildTree(domDump, tolerance)
  // 转换为 annotate 风格的输出：每节点 {id,name,type,layout,suggestedName,children}
  const mapNode = (n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    selector: n.selector,
    role: n.role,
    layout: n.layout,
    suggestedName: n.suggestedName,
    rect: n.rectAbsolute,
    children: n.children.map(mapNode),
  })
  const annotated = result.tree.map(mapNode)
  return { canvas: result.canvas, tree: annotated, stats: result.stats }
}

export { parsePadding, parseGap, isVisibleNode }
