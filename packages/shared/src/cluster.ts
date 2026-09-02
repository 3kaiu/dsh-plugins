'use strict'

// 共享聚类与容器判定内核 —— 被 layout-core.ts 与 dsl-clean.ts 共用
// 抽取前两文件各有一份几乎相同的实现；统一后单点维护，行为保持一致。
// 节点形态兼容两种归一化：{ _x,_y,_width,_height,_rotation,_color,_effect,_radius } (dsl-clean/reconstruct 后)
// 以及原始几何 { x,y,width,height,rotation }；函数内部统一取 _ 前缀优先。

export const GRADIENT_RE = /gradient|url\(|image-resource|\.png|\.jpe?g|\.webp/i

export function round1(v: any) {
  return Math.round(v * 10) / 10
}

function nodeW(n: any) { return n._width ?? n.width ?? n._width ?? 0 }
function nodeH(n: any) { return n._height ?? n.height ?? 0 }
function nodeX(n: any) { return n._x ?? n.x ?? 0 }
function nodeY(n: any) { return n._y ?? n.y ?? 0 }
function nodeRot(n: any) { return n._rotation ?? n.rotation ?? n.rotate ?? 0 }
function nodeColor(n: any) { return typeof n._color === 'string' ? n._color : typeof n._color === 'string' ? n._color : '' }
function nodeEffect(n: any) { return n._effect ?? n.effect ?? n._shadow ?? null }
function nodeRadius(n: any) { return n._radius ?? n.borderRadius ?? n.radius ?? null }

export function isBackgroundRect(n: any, canvasOrRect: any, maybeCanvas: any = null) {
  // 兼容两种调用：isBackgroundRect(n, canvas) 与 isBackgroundRect(n, rect, canvas)
  let canvas
  if (maybeCanvas) canvas = maybeCanvas
  else canvas = canvasOrRect
  const w = n._width ?? n.width ?? (canvasOrRect && canvasOrRect.width) ?? 0
  const h = n._height ?? n.height ?? (canvasOrRect && canvasOrRect.height) ?? 0
  const y = n._y ?? n.y ?? (canvasOrRect && canvasOrRect.y) ?? 0
  // 宽度阈值：全宽判定
  const widthForBg = n._width ?? n.width ?? w
  if (widthForBg < canvas.width * 0.8) return false
  if (Math.abs(nodeRot(n)) > 0.5) return false
  const isBottomStrip = y + h >= canvas.height - 10 && h <= 100
  if (isBottomStrip) return false
  const fill = typeof n._color === 'string' ? n._color : typeof n._color === 'string' ? n._color : ''
  const fillStr = fill || ''
  if (GRADIENT_RE.test(fillStr)) return true
  const eff = nodeEffect(n)
  if (eff && /blur|backdrop/i.test(String(eff))) return true
  if (n.opacity != null && n.opacity < 0.5) return true
  return false
}

export function isContainerCandidate(n: any) {
  if (n.type !== 'FRAME' && n.type !== 'GROUP' && n.type !== 'INSTANCE') return false
  if (Math.abs(nodeRot(n)) > 0.5) return false
  return true
}

export function clusterBandsAdaptive(items: any, canvas: any, tol: any = 2) {
  const sorted = [...items].sort((a: any, b: any) => nodeY(a) - nodeY(b))
  const bands = []
  for (const n of sorted) {
    const w = nodeW(n)
    const h = nodeH(n)
    const y = nodeY(n)
    const isFullWidthStrip = w >= canvas.width * 0.9 && h <= 60
    const end = y + h
    const last = bands[bands.length - 1]
    const gap = last ? y - last.maxEnd : 0
    if (isFullWidthStrip) {
      bands.push({ items: [n], maxEnd: end, fullWidth: true })
      continue
    }
    if (last && !last.fullWidth && gap <= 12) {
      last.items.push(n)
      last.maxEnd = Math.max(last.maxEnd, end)
    } else {
      bands.push({ items: [n], maxEnd: end, fullWidth: false })
    }
  }
  return bands
}

export function clusterCols(items: any, tol: any = 12) {
  const sorted = [...items].sort((a: any, b: any) => nodeX(a) - nodeX(b))
  const cols = []
  for (const n of sorted) {
    const x = nodeX(n)
    const w = nodeW(n)
    const end = x + w
    const last = cols[cols.length - 1]
    if (last && x - last.maxEnd <= tol) {
      last.items.push(n)
      last.maxEnd = Math.max(last.maxEnd, end)
    } else {
      cols.push({ items: [n], maxEnd: end })
    }
  }
  return cols
}

export function bandBBox(band: any) {
  const minX = Math.min(...band.items.map((n: any) => nodeX(n)))
  const minY = Math.min(...band.items.map((n: any) => nodeY(n)))
  const maxX = Math.max(...band.items.map((n: any) => nodeX(n) + nodeW(n)))
  const maxY = Math.max(...band.items.map((n: any) => nodeY(n) + nodeH(n)))
  return { x: round1(minX), y: round1(minY), width: round1(maxX - minX), height: round1(maxY - minY) }
}

export function bandSize(band: any) {
  const b = bandBBox(band)
  return { width: b.width, height: b.height }
}

export function bandMinX(band: any) {
  return Math.min(...band.items.map((n: any) => nodeX(n)))
}

export function bandMinY(band: any) {
  return Math.min(...band.items.map((n: any) => nodeY(n)))
}

export function colBBox(items: any) {
  const minX = Math.min(...items.map((n: any) => nodeX(n)))
  const minY = Math.min(...items.map((n: any) => nodeY(n)))
  const maxX = Math.max(...items.map((n: any) => nodeX(n) + nodeW(n)))
  const maxY = Math.max(...items.map((n: any) => nodeY(n) + nodeH(n)))
  return { x: round1(minX), y: round1(minY), width: round1(maxX - minX), height: round1(maxY - minY) }
}

export function colSize(items: any) {
  const b = colBBox(items)
  return { width: b.width, height: b.height }
}
