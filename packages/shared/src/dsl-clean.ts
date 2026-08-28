'use strict'

/**
 * dsl-clean: 堆叠稿 → 标准 DSL 清洗算法
 *
 * 输入: 拍平稿(堆叠稿)的扁平 sections —— 每个 section 是页面绝对坐标的碎片
 *       (单 TEXT / 单 PATH / 单 GROUP / 单 FRAME), 无 flexContainerInfo,
 *       机器命名, 无相对坐标。
 * 输出: 标准 DSL(与官方 demo DSL 形态对齐):
 *       - 语义容器树(FRAME 嵌套, 语义命名)
 *       - 每节点 layoutStyle.relativeX/Y 相对父容器
 *       - 容器 flexContainerInfo(flexDirection/justifyContent/alignItems/
 *         mainSizing/crossSizing/gap/padding) —— 由 inferLayout 反推
 *       - 样式 token 映射(styles) + _color 快捷值
 *       - 叶子保留原始 DSL 的 text/fill/svgKey 等全部渲染信息
 *
 * 验证契约: 清洗后的树重新渲染(模拟 flex + absolute), 每个叶子的页面绝对
 *           bbox 与输入 section 的 x/y/w/h 完全一致(容差 2px)。
 *
 * 纯函数, 无副作用。
 */

import { inferLayout, round1 } from './layout-core.ts'
import {
  isBackgroundRect as isBackgroundRectShared,
  isContainerCandidate as isContainerCandidateShared,
  clusterBandsAdaptive as clusterBandsAdaptiveShared,
  clusterCols as clusterColsShared,
  bandBBox as bandBBoxShared,
} from './cluster.ts'

const TOL = 2

// 复用共享聚类内核（原地保留别名，保持调用方不变）
const isBackgroundRect = isBackgroundRectShared
const isContainerCandidate = isContainerCandidateShared
const clusterBandsAdaptive = clusterBandsAdaptiveShared
const clusterCols = clusterColsShared
const bandBBox = bandBBoxShared

// =====================================================================
// 1. 归一化: section → 扁平节点(含页面绝对坐标 + 样式信号 + 原始 DSL)
// =====================================================================

/**
 * @param {object} opts
 * @param {{width:number,height:number}} opts.canvas
 * @param {Array} opts.sections 每项 {id,name,type,x,y,width,height,dsl:{styles,nodes}}
 */
function normalize({ canvas, sections }) {
  const nodes = sections.map((s, i) => {
    const root = s.dsl && s.dsl.nodes ? s.dsl.nodes[0] : null
    const ls = root && root.layoutStyle ? root.layoutStyle : {}
    const color = root && root._color != null ? root._color : null
    const effect = root && root.effect ? root.effect : null
    const radius = root && root.borderRadius ? root.borderRadius : null
    const rotation = ls.rotate || 0
    return {
      _idx: i,
      id: s.id,
      name: s.name,
      type: s.type,
      _x: s.x,
      _y: s.y,
      _width: s.width,
      _height: s.height,
      _rotation: rotation,
      _color: color,
      _effect: effect,
      _radius: radius,
      _dsl: s.dsl || null,
      _section: s,
    }
  })
  return { canvas, nodes }
}

// =====================================================================
// 2. 分类 + 容器吸收 + 带状聚类(语义角色)
// =====================================================================

// =====================================================================
// 3. 语义命名
// =====================================================================

/** 从 section 的 DSL 提取首个文本(用于命名/识别) */
function firstText(n) {
  const dsl = n._dsl
  if (!dsl || !dsl.rowTexts || !dsl.rowTexts.length) return null
  const t = dsl.rowTexts[0]
  return typeof t === 'string' ? t : t.text
}

/** 语义命名: 角色 + 内容启发式 */
function semanticName(n, role, canvas) {
  if (role === 'background') return 'hero-background'
  if (role === 'status-bar') return 'status-bar'
  if (role === 'tab-bar') return 'tab-bar'
  if (role === 'tab-item') return firstText(n) ? 'tab-item-' + firstText(n) : 'tab-item'
  if (role === 'sticker') return 'sticker-' + (firstText(n) || n.name)
  if (role === 'off-canvas') return 'floating-text'
  if (role === 'nav-bar') {
    const t = firstText(n)
    return t ? 'nav-bar-' + t : 'nav-bar'
  }
  if (role === 'learn-card') return 'learn-card'
  if (role === 'sticker-card') return 'sticker-card'
  if (role === 'stats-row') return 'stats-row'
  if (role === 'content-tabs') return 'content-tabs'
  if (role === 'hero') return 'hero'
  if (role === 'column-group') return 'column-group'
  if (role === 'row-group') return 'row-group'
  const t = firstText(n)
  return t ? 'item-' + t : n.name
}

/** 识别带内布局角色(基于内容/位置信号) */
function bandRole(band, canvas) {
  const first = band.items[0]
  const texts = band.items.map(firstText).filter(Boolean)
  // 全宽条
  if (band.fullWidth) {
    if (first._y <= 30) return 'status-bar'
    if (first._y + first.height >= canvas.height - 10) return 'tab-bar'
    return 'nav-bar'
  }
  // 大数字 hero: 高 ≥40 的纯数字文本
  if (band.items.some((n) => /^\d+$/.test(firstText(n) || '') && n._height >= 40)) return 'hero'
  // 贴纸卡: 内含"贴纸组"(有旋转子层) 且文本含英文贴纸词
  if (band.items.length === 1) {
    const n = band.items[0]
    const t = firstText(n) || ''
    if (band.items.some((x) => x._radius)) return 'card'
    if (/^[a-zA-Z\s]+$/.test(t) && n.type === 'GROUP') return 'sticker'
    if (n._effect && /shadow/i.test(String(n._effect))) {
      if (t === 'mines' || n.children?.some((c) => c._rotation)) return 'sticker-card'
      return 'card'
    }
  }
  // 内容 tabs: 文本含"课程/直播/词书"且容器有阴影
  if (band.items.length === 1 && /课程|直播/.test(texts.join(''))) return 'content-tabs'
  // 学习卡: 文本含"学单词"
  if (band.items.length === 1 && /学单词|复习|新词/.test(texts.join(''))) return 'learn-card'
  // 统计行: 文本含"今日/近7日"等
  if (/今日|近7日|学会/.test(texts.join(''))) return 'stats-row'
  // 多节点带
  if (band.items.length === 1) {
    if (Math.abs(first._rotation) > 0.5) return 'sticker'
    const t = firstText(first)
    if (/^\d+$/.test(t || '')) return 'hero'
    return 'card'
  }
  return 'row-group'
}

// =====================================================================
// 4. 输出标准 DSL
// =====================================================================

/**
 * 节点 → 标准 DSL 叶子(保留原始 DSL 渲染信息)
 * @param {object} n 归一化节点
 * @param {{x:number,y:number}} origin 父容器原点(页面坐标)
 */
function leafToDsl(n, origin) {
  const dslRoot = n._dsl && n._dsl.nodes ? n._dsl.nodes[0] : null
  const ls = dslRoot && dslRoot.layoutStyle ? dslRoot.layoutStyle : {}
  const out = {
    type: dslRoot ? dslRoot.type : n.type,
    id: n.id,
    name: n.name,
    layoutStyle: {
      width: round1(n._width),
      height: round1(n._height),
      relativeX: round1(n._x - origin.x),
      relativeY: round1(n._y - origin.y),
    },
  }
  if (Math.abs(n._rotation) > 0.5) out.layoutStyle.rotate = round1(n._rotation)
  // 透传原始渲染字段(全部)
  if (dslRoot) {
    for (const k of ['fill', '_color', 'effect', 'borderRadius', 'strokeColor', 'strokeType', 'strokeAlign', 'strokeWidth', 'opacity', 'text', 'rowTexts', 'textColor', 'textAlign', 'textMode', 'font', 'svgKey', 'svgShortKey', 'svgName', 'path', 'rotate', 'componentInfo', 'componentId', '_mergedVector', 'flexShrink', 'flexGrow']) {
      if (dslRoot[k] !== undefined) out[k] = dslRoot[k]
    }
    // 内部子节点树原样保留(相对该节点自身的相对坐标)
    if (dslRoot.children && dslRoot.children.length) out.children = dslRoot.children
  }
  // 文本可能位于 section 级 rowTexts(TEXT 节点短文本内联在 node.text)
  if (out.text === undefined && n._dsl && n._dsl.rowTexts && n._dsl.rowTexts.length) {
    out.rowTexts = n._dsl.rowTexts
    const first = n._dsl.rowTexts[0]
    out.text = typeof first === 'string' ? first : first.text
  }
  return out
}

/**
 * 容器 → 标准 DSL 节点
 * @param {object} c 容器 {bbox, role, layout, children, origin(父容器原点)}
 */
function containerToDsl(c) {
  const origin = c.origin || { x: 0, y: 0 }
  const out = {
    type: 'FRAME',
    id: c.id,
    name: c.name,
    layoutStyle: {
      width: round1(c.bbox.width),
      height: round1(c.bbox.height),
      relativeX: round1(c.bbox.x - origin.x),
      relativeY: round1(c.bbox.y - origin.y),
    },
  }
  if (c.fill) out.fill = c.fill
  if (c._color) out._color = c._color
  if (c.effect) out.effect = c.effect
  if (c.radius) out.borderRadius = c.radius
  if (c.layout && c.layout.position === 'flex') {
    out.flexContainerInfo = flexInfo(c.layout)
  }
  out.children = c.children
  return out
}

/** inferLayout 结果 → 技术中立 flexContainerInfo(gap/padding 输出结构化数字, 不绑定任何 CSS/框架) */
function flexInfo(layout) {
  const info = {
    flexDirection: layout.flexDirection,
    mainSizing: layout.mainSizing || 'auto',
    crossSizing: layout.crossSizing || 'auto',
  }
  if (layout.justifyContent) info.justifyContent = layout.justifyContent
  if (layout.alignItems) info.alignItems = layout.alignItems
  if (layout.gap != null && layout.gap > 0) {
    const g = Math.round(layout.gap)
    info.gap = { row: g, column: g }
  }
  if (layout.padding && layout.padding.some((p) => p > 0.01)) {
    // [top, right, bottom, left] — 与框架无关的数字序列
    info.padding = layout.padding.map((v) => Math.round(v))
  }
  return info
}

/** [上,右,下,左] → 保留(测试/工具用) */

// =====================================================================
// 6. LLM 结构描述(技术中立): 树形缩进摘要
//    给 LLM 的"读图输入" —— 不出现任何前端技术关键词,
//    只描述布局意图: 层次/尺寸/相对位置/定位方式/颜色/文本/图标。
// =====================================================================

/**
 * 把清洗后的标准 DSL 树渲染成紧凑、语义化的结构描述文本。
 * 用于注入 LLM 提示词, 让模型理解布局结构后自行选择实现技术。
 *
 * 描述中立原则: 只出现"画布/容器/文本/图标/颜色/旋转/布局(行列/绝对定位)"
 * 等概念 —— 不出现 div/css/flexbox/View 等任何具体前端技术词汇。
 *
 * @param {object} dsl cleanToStandardDsl 的返回对象(或其 root)
 * @returns {string} 缩进树形文本
 */
export function describeStructure(dsl) {
  const root = dsl.root || dsl
  const canvas = dsl.meta && dsl.meta.canvas ? dsl.meta.canvas : null
  const lines = []
  if (canvas) lines.push(`画布 ${canvas.width}x${canvas.height}`)
  const walk = (node, depth, origin) => {
    const ls = node.layoutStyle || {}
    const x = origin.x + (ls.relativeX || 0)
    const y = origin.y + (ls.relativeY || 0)
    const pad = '  '.repeat(depth)
    const dim = `${Math.round(ls.width || 0)}x${Math.round(ls.height || 0)}`
    const pos = `@${Math.round(x)},${Math.round(y)}`
    const rot = ls.rotate ? ` 旋转${Math.round(ls.rotate * 10) / 10}°` : ''
    // 定位方式(技术中立词汇)
    let layout = ''
    if (node.flexContainerInfo) {
      const f = node.flexContainerInfo
      layout = ` 布局=${f.flexDirection}`
      if (f.justifyContent) layout += ` 主轴对齐=${f.justifyContent}`
      if (f.alignItems) layout += ` 交叉对齐=${f.alignItems}`
      if (f.gap) layout += ` 间距=${f.gap.row}/${f.gap.column}`
      if (f.padding) layout += ` 内边距=[${f.padding.join(',')}]`
    } else if (node.children && node.children.length) {
      layout = ' 布局=自由定位'
    }
    // 视觉信号
    const signals = []
    if (typeof node._color === 'string') signals.push('颜色:' + node._color)
    if (node.fill && typeof node.fill === 'string' && !/^paint_/.test(node.fill)) signals.push('填充:' + node.fill)
    if (node.effect) signals.push('效果:' + (typeof node.effect === 'string' ? node.effect : JSON.stringify(node.effect)))
    if (node.borderRadius) signals.push('圆角:' + node.borderRadius)
    if (node.role) signals.push('角色:' + node.role)
    if (node.svgShortKey || node.svgName) {
      const namePart = node.svgName ? node.svgName : ''
      const keyPart = node.svgShortKey ? node.svgShortKey : ''
      if (namePart && keyPart) signals.push(`图标:${namePart}(${keyPart})`)
      else if (namePart) signals.push(`图标:${namePart}`)
      else signals.push(`图标:${keyPart}`)
    }
    // 文本内容(短文本直接内联, 长文本保留占位符)
    const texts = []
    if (typeof node.text === 'string') texts.push(node.text)
    if (Array.isArray(node.rowTexts)) for (const t of node.rowTexts) texts.push(typeof t === 'string' ? t : t.text)
    const unique = [...new Set(texts.filter(Boolean))]
    if (unique.length) signals.push('文本:"' + unique.join(' / ') + '"')
    const suffix = signals.length ? ' [' + signals.join(' | ') + ']' : ''
    lines.push(`${pad}${node.name}${dim}${pos}${rot}${layout}${suffix}`)
    if (node.children) for (const c of node.children) walk(c, depth + 1, { x, y })
  }
  walk(root, 0, { x: 0, y: 0 })
  return lines.join('\n')
}

// =====================================================================
// 5. 主入口
// =====================================================================

/**
 * 清洗堆叠稿 → 标准 DSL
 *
 * @param {object} opts
 * @param {{width:number,height:number}} opts.canvas 画布尺寸
 * @param {Array} opts.sections 扁平 sections(见 normalize)
 * @param {object} [opts.rootMeta] 根容器元信息 {name, background}
 * @returns {{meta:object, styles:object, root:object, stats:object, warnings:Array}}
 */
export function cleanToStandardDsl({ canvas, sections, rootMeta }) {
  const warnings = []
  const { nodes } = normalize({ canvas, sections })
  const stats = { total: nodes.length, offCanvas: 0, background: 0, sticker: 0, container: 0, band: 0 }

  // ---- 0. 分类 ----
  const offCanvas = nodes.filter((n) => n._x + n._width > canvas.width + 8 || n._x < -8 || n._y < -8 || n._y + n._height > canvas.height + 8)
  stats.offCanvas = offCanvas.length
  let rest = nodes.filter((n) => !offCanvas.includes(n))

  const backgrounds = rest.filter((n) => isBackgroundRect(n, canvas))
  stats.background = backgrounds.length
  rest = rest.filter((n) => !backgrounds.includes(n))

  // ---- 1. 容器吸收 ----
  const absorbed = new Map()
  const assigned = new Set()
  const absorbedContainers = new Set()
  const standaloneContainers = new Set()
  const containers = rest.filter(isContainerCandidate).sort((a, b) => a._width * a._height - b._width * b._height)

  for (const c of containers) {
    if (assigned.has(c.id) || absorbedContainers.has(c.id) || standaloneContainers.has(c.id)) continue
    const kids = rest.filter((n) => {
      if (n === c || assigned.has(n.id) || absorbedContainers.has(n.id) || standaloneContainers.has(n.id)) return false
      const inside = n._x >= c._x - 2 && n._y >= c._y - 2 && n._x + n._width <= c._x + c._width + 2 && n._y + n._height <= c._y + c._height + 2
      if (!inside) return false
      return n._width * n._height < c._width * c._height * 0.9
    })
    if (kids.length > 0) {
      absorbed.set(c.id, kids)
      for (const k of kids) assigned.add(k.id)
      absorbedContainers.add(c.id)
      stats.container++
    } else if (c._effect || c._color || c._radius) {
      standaloneContainers.add(c.id)
      stats.container++
    }
  }

  // ---- 2. 带状聚类 ----
  const floaters = rest.filter((n) => !assigned.has(n.id) && !absorbedContainers.has(n.id) && !standaloneContainers.has(n.id))
  const stickers = floaters.filter((n) => Math.abs(n._rotation) > 0.5)
  stats.sticker = stickers.length
  const bandFloaters = floaters.filter((n) => !stickers.includes(n))
  const bands = clusterBandsAdaptive(bandFloaters, canvas)
  stats.band = bands.length

  // ---- 3. 构建树 ----
  const children = []

  // 3a. 背景层
  for (const bg of backgrounds) {
    const l = leafToDsl(bg, { x: 0, y: 0 })
    l.name = 'hero-background'
    children.push(l)
  }

  // 3b. 独立容器块(学习卡/贴纸卡/内容tabs 等)
  const containerBlocks = rest.filter((n) => absorbedContainers.has(n.id) || standaloneContainers.has(n.id))
  for (const c of containerBlocks) {
    const kids = absorbed.get(c.id) || []
    const role = detectContainerRole(c, kids)
    const bbox = { x: c._x, y: c._y, width: c._width, height: c._height }
    const layout = kids.length
      ? inferLayout({
          container: { width: c._width, height: c._height },
          children: kids.map((k) => ({ id: k.id, x: k._x - c._x, y: k._y - c._y, width: k._width, height: k._height, rotation: k._rotation })),
        })
      : null
    const childNodes = kids.map((k) => {
      if (Math.abs(k._rotation) > 0.5) {
        const l = leafToDsl(k, { x: c._x, y: c._y })
        l.role = 'sticker'
        return l
      }
      return leafToDsl(k, { x: c._x, y: c._y })
    })
    // 容器自身 DSL 的内嵌子节点(坐标相对容器自身)优先保留
    const dslKids = c._dsl && c._dsl.nodes && c._dsl.nodes[0] && c._dsl.nodes[0].children ? c._dsl.nodes[0].children : null
    if (dslKids && dslKids.length) {
      if (!childNodes.length) childNodes.push(...dslKids)
      else childNodes.push(...dslKids.filter((k) => !childNodes.some((c2) => c2.id === k.id)))
    }
    children.push(
      containerToDsl({
        id: c.id,
        name: semanticName(c, role, canvas),
        bbox,
        layout,
        children: childNodes,
        fill: typeof c._color === 'string' ? undefined : c._color,
        _color: typeof c._color === 'string' ? c._color : undefined,
        effect: c._effect,
        radius: c._radius,
      }),
    )
  }

  // 3c. 带状块
  for (const band of bands) {
    const role = bandRole(band, canvas)
    const bbox = bandBBox(band)
    // 底部 tab-bar: 全宽、贴底、矮条(高度 ≤90, 即使背景条本身 >60)
    const isBottomTabBar = role !== 'tab-bar' && bbox.y + bbox.height >= canvas.height - 10 && bbox.width >= canvas.width * 0.9 && bbox.height <= 90
    if (role === 'tab-bar' || isBottomTabBar) {
      children.push(buildTabBar(band, canvas))
      continue
    }
    if (role === 'sticker' || (band.items.length === 1 && !band.fullWidth && !band.items[0]._effect && !band.items[0]._color)) {
      // 单叶子
      const n = band.items[0]
      const t = firstText(n)
      const leaf = leafToDsl(n, { x: 0, y: 0 })
      leaf.role = role === 'sticker' ? 'sticker' : undefined
      if (role === 'hero') leaf.name = 'hero-' + (t || 'count')
      children.push(leaf)
      continue
    }
    if (band.fullWidth) {
      const n = band.items[0]
      const layout = inferLayout({
        container: { width: n._width, height: n._height },
        children: band.items.slice(1).map((k) => ({ id: k.id, x: k._x - n._x, y: k._y - n._y, width: k._width, height: k._height, rotation: k._rotation })),
      })
      const inner = band.items.slice(1).map((k) => leafToDsl(k, { x: n._x, y: n._y }))
      const out = containerToDsl({ id: n.id, name: semanticName(n, role, canvas), bbox: { x: n._x, y: n._y, width: n._width, height: n._height }, layout, children: inner, fill: undefined, _color: typeof n._color === 'string' ? n._color : undefined, effect: n._effect, radius: n._radius })
      // 状态栏/导航栏是容器: 保留原始 DSL 子节点
      out.children = (n._dsl?.nodes?.[0]?.children || []).map((c) => c)
      children.push(out)
      continue
    }
    // 多节点带: 委托 inferLayout
    const relKids = band.items.map((k) => ({ id: k.id, x: k._x - bbox.x, y: k._y - bbox.y, width: k._width, height: k._height, rotation: k._rotation }))
    const layout = inferLayout({ container: { width: bbox.width, height: bbox.height }, children: relKids })
    const subChildren = clusterCols(band.items).map((col) => {
      const sorted = [...col.items].sort((a, b) => a._y - b._y || a._x - b._x)
      if (sorted.length === 1) return leafToDsl(sorted[0], { x: bbox.x, y: bbox.y })
      const cb = colBBox(sorted)
      const colLayout = inferLayout({
        container: { width: cb.width, height: cb.height },
        children: sorted.map((k) => ({ id: k.id, x: k._x - cb.x, y: k._y - cb.y, width: k._width, height: k._height, rotation: k._rotation })),
      })
      return containerToDsl({
        id: 'synthetic:column-group:' + sorted[0].id,
        name: role === 'stats-row' ? 'stats-item' : 'column-group',
        bbox: cb,
        layout: colLayout,
        children: sorted.map((k) => leafToDsl(k, { x: cb.x, y: cb.y })),
        origin: bbox,
      })
    })
    children.push(
      containerToDsl({
        id: 'synthetic:' + role + ':' + band.items[0].id,
        name: semanticName(band.items[0], role, canvas),
        bbox,
        layout,
        children: subChildren,
      }),
    )
  }

  // 3d. 顶层 sticker + off-canvas
  for (const s of stickers) {
    const l = leafToDsl(s, { x: 0, y: 0 })
    l.role = 'sticker'
    children.push(l)
  }
  for (const o of offCanvas) children.push(leafToDsl(o, { x: 0, y: 0 }))

  // ---- 4. 根容器 + 样式表 ----
  const rootBBox = { x: 0, y: 0, width: canvas.width, height: canvas.height }
  const root = containerToDsl({
    id: 'synthetic:root',
    name: rootMeta && rootMeta.name ? rootMeta.name : 'root',
    bbox: rootBBox,
    layout: null,
    children,
  })
  if (rootMeta && rootMeta.background) {
    root._color = rootMeta.background
    root.fill = 'paint_root:background'
  }

  const styles = {}
  for (const n of nodes) {
    if (n._dsl && n._dsl.styles) Object.assign(styles, n._dsl.styles)
  }

  return {
    meta: {
      canvas: { width: canvas.width, height: canvas.height },
      rootName: rootMeta && rootMeta.name ? rootMeta.name : 'root',
      source: rootMeta && rootMeta.source ? rootMeta.source : '',
    },
    styles,
    root,
    stats,
    warnings,
  }
}

// =====================================================================
// 辅助
// =====================================================================

function detectContainerRole(c, kids) {
  const texts = [...kids.map(firstText), ...(c._dsl && c._dsl.rowTexts ? c._dsl.rowTexts.map((t) => (typeof t === 'string' ? t : t.text)) : [])].filter(Boolean)
  const t = texts.join('')
  if (c._effect && /shadow/i.test(String(c._effect)) && /学单词|新词|复习/.test(t)) return 'learn-card'
  if (kids.some((k) => Math.abs(k._rotation) > 0.5)) return 'sticker-card'
  if (/学单词|新词|复习/.test(t)) return 'learn-card'
  if (/课程|直播/.test(t)) return 'content-tabs'
  if (/^[a-zA-Z\s]+$/.test(t) && kids.length) return 'sticker-card'
  return 'card'
}

function colBBox(items) {
  const minX = Math.min(...items.map((n) => n._x))
  const minY = Math.min(...items.map((n) => n._y))
  const maxX = Math.max(...items.map((n) => n._x + n._width))
  const maxY = Math.max(...items.map((n) => n._y + n._height))
  return { x: round1(minX), y: round1(minY), width: round1(maxX - minX), height: round1(maxY - minY) }
}

/** TabBar 构建: 全宽背景条 + icon/label 对 + home indicator(全部 absolute 定位, 保证几何精确) */
function buildTabBar(band, canvas) {
  const bg = band.items.find((n) => n._width >= canvas.width * 0.9)
  const items = band.items.filter((n) => n !== bg && !n.name.includes('Home Indicator'))
  const home = band.items.find((n) => n.name.includes('Home Indicator'))
  const icons = items.filter((n) => n.type !== 'TEXT' && n._height <= 30 && n._width <= 40)
  const labels = items.filter((n) => n.type === 'TEXT')

  // icon/label 按 x 对齐配对
  const pairs = []
  const usedLabels = new Set()
  for (const ic of icons) {
    let best = null
    let bestDist = Infinity
    for (const lb of labels) {
      if (usedLabels.has(lb.id)) continue
      const dx = Math.abs(lb._x + lb._width / 2 - (ic._x + ic._width / 2))
      const dy = lb._y - (ic._y + ic._height)
      if (dx <= 40 && dy >= -4 && dy < bestDist) {
        best = lb
        bestDist = dy
      }
    }
    if (best) usedLabels.add(best.id)
    pairs.push({ icon: ic, label: best })
  }

  const bbox = { x: 0, y: bg ? bg._y : band.items[0]._y, width: canvas.width, height: canvas.height - (bg ? bg._y : band.items[0]._y) }
  const origin = { x: 0, y: bbox.y }
  const children = []

  if (bg) {
    const bgl = leafToDsl(bg, origin)
    bgl.role = 'tab-bar-bg'
    children.push(bgl)
  }

  // tab-item: 24×38 容器, icon(0,0) + label(相对), flex column 语义
  for (const p of pairs) {
    if (!p.icon) continue
    const labelText = p.label ? firstText(p.label) || p.label.name : p.icon.name
    const ib = { x: p.icon._x, y: p.icon._y, width: 24, height: 38 }
    const kids = []
    const ic = leafToDsl(p.icon, ib)
    ic.role = 'tab-icon'
    kids.push(ic)
    if (p.label) {
      const lb = leafToDsl(p.label, ib)
      lb.role = 'tab-label'
      kids.push(lb)
    }
    children.push(
      containerToDsl({
        id: 'synthetic:tab-item:' + p.icon.id,
        name: 'tab-item-' + labelText,
        bbox: ib,
        layout: { position: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', gap: 0, padding: null, mainSizing: 'auto', crossSizing: 'fixed' },
        children: kids,
        origin,
      }),
    )
  }

  // 未配对的 label
  const leftover = labels.filter((l) => !pairs.some((p) => p.label && p.label.id === l.id))
  for (const l of leftover) children.push(leafToDsl(l, origin))
  if (home) children.push(leafToDsl(home, origin))

  return containerToDsl({
    id: 'synthetic:tab-bar:' + band.items[0].id,
    name: 'tab-bar',
    bbox,
    layout: null,
    children,
  })
}

export { normalize, clusterBandsAdaptive, semanticName, bandRole, flexInfo }
