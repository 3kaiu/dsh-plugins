'use strict'

// 清洗算法验证: 渲染一致性 + 语义命名
// 1) 读入堆叠稿 fixture(mg-stacked-sections.json: 30 个扁平节点 + 文本)
// 2) cleanToStandardDsl → 标准 DSL 树
// 3) 模拟渲染(absolute + flex 展开) → 每节点页面绝对 bbox
// 4) 与输入 30 个节点的原始 bbox 对比, 断言偏差 ≤ 容差
// 5) 断言语义命名与 flexContainerInfo
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanToStandardDsl } from '../src/dsl-clean.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'layout-infer', 'fixtures', 'mg-stacked-sections.json')
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'))

const sections = fx.nodes.map((n) => ({
  id: n.id,
  name: n.name,
  type: n.type,
  x: n.x,
  y: n.y,
  width: n.width,
  height: n.height,
  dsl: {
    styles: {},
    rowTexts: (n.texts || []).map((t) => ({ text: t, parentType: n.type, parentName: n.name })),
    nodes: [{ type: n.type, id: n.id, name: n.name, layoutStyle: { width: n.width, height: n.height, relativeX: 0, relativeY: 0, ...(n.rotation != null ? { rotate: n.rotation } : {}) }, ...(n._color != null ? { _color: n._color } : {}), ...(n.effect != null ? { effect: n.effect } : {}) }],
  },
}))

const result = cleanToStandardDsl({
  canvas: fx.meta.canvas,
  sections,
  rootMeta: { name: fx.meta.rootName, background: '#F6F7FB' },
})

// ---- 渲染模拟 ----
function render(node, parentOrigin, out, flexPlaced) {
  const x = flexPlaced ? parentOrigin.x : parentOrigin.x + node.layoutStyle.relativeX
  const y = flexPlaced ? parentOrigin.y : parentOrigin.y + node.layoutStyle.relativeY
  out.push({ id: node.id, x, y, width: node.layoutStyle.width, height: node.layoutStyle.height })
  const isFlex = node.flexContainerInfo && node.flexContainerInfo.flexDirection
  if (!node.children || node.children.length === 0) {
    return
  }
  if (isFlex) {
    const info = node.flexContainerInfo
    const dir = info.flexDirection === 'row' ? 'row' : 'column'
    const kids = node.children
    // 技术中立格式: gap={row,column}, padding=[top,right,bottom,left]
    const gap = info.gap ? (typeof info.gap === 'object' ? info.gap.row : 0) : 0
    const pads = Array.isArray(info.padding) ? info.padding : []
    const pT = pads[0] || 0
    const pR = pads[1] != null ? pads[1] : pT
    const pB = pads[2] != null ? pads[2] : pT
    const pL = pads[3] != null ? pads[3] : pR
    const mainSize = (dir === 'row' ? node.layoutStyle.width : node.layoutStyle.height) - (dir === 'row' ? pL + pR : pT + pB)
    const crossSize = (dir === 'row' ? node.layoutStyle.height : node.layoutStyle.width) - (dir === 'row' ? pT + pB : pL + pR)
    const sorted = [...kids].sort((a, b) => (dir === 'row' ? a.layoutStyle.relativeX : a.layoutStyle.relativeY) - (dir === 'row' ? b.layoutStyle.relativeX : b.layoutStyle.relativeY))
    let cursor = 0
    const placements = []
    if (info.justifyContent === 'space-around') {
      const total = sorted.reduce((s, k) => s + (dir === 'row' ? k.layoutStyle.width : k.layoutStyle.height), 0) + gap * (sorted.length - 1)
      const slot = (mainSize - total) / sorted.length
      sorted.forEach((k) => {
        const sz = dir === 'row' ? k.layoutStyle.width : k.layoutStyle.height
        placements.push({ k, main: cursor + slot / 2 })
        cursor += sz + gap + slot
      })
    } else if (info.justifyContent === 'space-between') {
      const total = sorted.reduce((s, k) => s + (dir === 'row' ? k.layoutStyle.width : k.layoutStyle.height), 0)
      const slot = (mainSize - total) / Math.max(1, sorted.length - 1)
      sorted.forEach((k) => {
        placements.push({ k, main: cursor })
        cursor += (dir === 'row' ? k.layoutStyle.width : k.layoutStyle.height) + slot
      })
    } else {
      sorted.forEach((k) => {
        placements.push({ k, main: cursor })
        cursor += (dir === 'row' ? k.layoutStyle.width : k.layoutStyle.height) + gap
      })
      if (info.justifyContent === 'center' || info.justifyContent === 'flex-end') {
        const total = sorted.reduce((s, k) => s + (dir === 'row' ? k.layoutStyle.width : k.layoutStyle.height), 0) + gap * (sorted.length - 1)
        const offset = info.justifyContent === 'center' ? (mainSize - total) / 2 : mainSize - total
        for (const p of placements) p.main += offset
      }
    }
    for (const { k, main } of placements) {
      let cross = 0
      const align = info.alignItems || 'start'
      if (align === 'center') cross = (crossSize - (dir === 'row' ? k.layoutStyle.height : k.layoutStyle.width)) / 2
      else if (align === 'end' || align === 'flex-end') cross = crossSize - (dir === 'row' ? k.layoutStyle.height : k.layoutStyle.width)
      const childOrigin = dir === 'row' ? { x: x + pL + main, y: y + pT + cross } : { x: x + pL + cross, y: y + pT + main }
      render(k, childOrigin, out, true)
    }
  } else {
    for (const k of node.children) render(k, { x, y }, out, false)
  }
}

const leaves = []
render(result.root, { x: 0, y: 0 }, leaves, false)
const leafById = new Map(leaves.map((l) => [l.id, l]))

// ---- 几何一致性 ----
const TOL = 2.5
let maxDelta = 0
const failures = []
for (const n of fx.nodes) {
  const l = leafById.get(n.id)
  if (!l) {
    failures.push(`${n.name}(${n.id}): 未渲染`)
    continue
  }
  const dx = Math.abs(l.x - n.x)
  const dy = Math.abs(l.y - n.y)
  const dw = Math.abs(l.width - n.width)
  const dh = Math.abs(l.height - n.height)
  maxDelta = Math.max(maxDelta, dx, dy, dw, dh)
  if (dx > TOL || dy > TOL || dw > TOL || dh > TOL) {
    failures.push(`${n.name}: 期望(${n.x},${n.y},${n.width},${n.height}) 实际(${l.x.toFixed(1)},${l.y.toFixed(1)},${l.width.toFixed(1)},${l.height.toFixed(1)})`)
  }
}

console.log('stats:', JSON.stringify(result.stats))
console.log('root:', result.root.name, result.root.layoutStyle.width + 'x' + result.root.layoutStyle.height, 'children=' + result.root.children.length)
console.log('maxDelta:', maxDelta.toFixed(2), 'px')
if (failures.length) {
  console.log('FAILURES (' + failures.length + '):')
  for (const f of failures) console.log(' -', f)
  process.exit(1)
} else {
  console.log(`清洗渲染一致性 ✓ (${fx.nodes.length} 节点全部几何一致)`)
}

// ---- 语义命名 ----
const names = new Set()
const walk = (ns) => {
  for (const n of ns) {
    names.add(n.name)
    if (n.children) walk(n.children)
  }
}
walk(result.root.children)
const mustHave = ['hero-background', 'status-bar', 'nav-bar', 'learn-card', 'sticker-card', 'stats-row', 'content-tabs', 'tab-bar']
const missing = mustHave.filter((m) => ![...names].some((n) => n.startsWith(m)))
if (missing.length) {
  console.log('语义命名缺失:', missing.join(', '))
  console.log('全部名称:', [...names].join(', '))
  process.exit(1)
}
console.log('语义命名 ✓')
const tabItems = [...names].filter((n) => n.startsWith('tab-item-'))
const wantTabs = ['tab-item-首页', 'tab-item-对话', 'tab-item-学习', 'tab-item-场景', 'tab-item-我的']
const missingTabs = wantTabs.filter((t) => !tabItems.includes(t))
if (missingTabs.length) {
  console.log('Tab item 命名缺失:', missingTabs.join(', '), 'got:', tabItems.join(', '))
  process.exit(1)
}
console.log('Tab 命名 ✓')
console.log('统计:', JSON.stringify(result.stats))