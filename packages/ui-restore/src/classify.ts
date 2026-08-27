
import { extractExactStyles } from './layout-core.ts';

// classify.js — 还原决策分类层(Step 1)
// 输入: MasterGo DSL({styles, nodes, components}) 或纯几何节点树
// 输出: 每节点 {kind, sizing, position, spacing} 语义决策,均带 confidence + reason;
//       以及资产清单(可内联 SVG 的图标 / 需导出的图片 / 文本)。
//
// 信号优先级(从强到弱):
//   1. 原生约束直读: flexContainerInfo.mainSizing/crossSizing、textMode、
//      flexContainerInfo.alignItems —— MasterGo 自动布局给出的官方答案,零推断
//   2. 类型直读: TEXT / PATH / image-fill —— 决定 text/icon/image
//   3. 语义命名: icon/logo/img/avatar 等设计规范约定
//   4. 几何反推: gap/padding(无原生间距字段时复用 inferLayout)
import { inferLayout } from './layout-core.ts'
import { detectRepeatGroups } from './repeat.ts'
import { systemChromeOf } from './system-chrome.ts'

const round = (n) => Math.round((n || 0) * 100) / 100
const ICON_NAME = /icon|ic[_-]|logo|glyph/i
const IMAGE_NAME = /img|image|photo|avatar|banner|cover|thumbnail/i

// 解析 fill 引用: "paint_755:01780" -> styles.paint_755:01780.value
function paintValue(styles, fill) {
  if (fill == null) return null
  if (typeof fill === 'string' && styles && styles[fill] && styles[fill].value != null) {
    return styles[fill].value
  }
  return fill
}

// paint 引用 -> 首个可用的 CSS 色值/渐变串
function resolvePaint(styles, ref) {
  const v = paintValue(styles, ref)
  if (Array.isArray(v)) return v[0] ?? null
  if (typeof v === 'string') return v
  return null
}

// PATH 节点 -> 可内联 SVG 字符串
function svgOf(node, styles) {
  const ls = node.layoutStyle || {}
  const w = round(ls.width ?? 0)
  const h = round(ls.height ?? 0)
  const paths = (node.path || [])
    .map((p) => {
      const fill = resolvePaint(styles, p.fill)
      return `<path d="${p.data}"${fill ? ` fill="${fill}"` : ''}/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">${paths}</svg>`
}

// ---- 维度 1: 节点类别 kind ----
function kindOf(node, styles) {
  const type = node.type
  const kids = node.children || []
  const paint = paintValue(styles, node.fill)
  const paintStr = Array.isArray(paint) ? JSON.stringify(paint) : String(paint ?? '')

  if (type === 'TEXT') return { kind: 'text', confidence: 1, reason: ['type=TEXT 文本节点'] }
  if (type === 'PATH' || Array.isArray(node.path)) {
    return { kind: 'icon', confidence: 1, reason: ['type=PATH 矢量路径,可内联 SVG'] }
  }
  if (type === 'IMAGE' || /url\(|data:image|\.png|\.jpe?g|\.webp|\.gif/i.test(paintStr)) {
    return { kind: 'image', confidence: 1, reason: ['fill 为位图/图片资源,需导出切图'] }
  }
  if (kids.length > 0) return { kind: 'container', confidence: 1, reason: ['含子节点,容器'] }

  const name = node.name || ''
  if (ICON_NAME.test(name)) return { kind: 'icon', confidence: 0.6, reason: ['无子节点且命名含 icon 语义,按图标处理'] }
  if (IMAGE_NAME.test(name)) return { kind: 'image', confidence: 0.6, reason: ['无子节点且命名含图片语义,按图片处理'] }
  if (paint || node.fill) return { kind: 'shape', confidence: 0.8, reason: ['无子节点但有填充,装饰形状(CSS 实现)'] }
  return { kind: 'spacer', confidence: 0.6, reason: ['无子节点无填充,结构占位'] }
}

// ---- 维度 2: 尺寸语义 sizing(内容撑开 vs 固定) ----
function sizingOf(node) {
  const fi = node.flexContainerInfo
  if (fi && (fi.mainSizing || fi.crossSizing)) {
    const main = fi.mainSizing === 'auto' || fi.mainSizing === 'fixed' ? fi.mainSizing : null
    const cross = fi.crossSizing === 'auto' || fi.crossSizing === 'fixed' ? fi.crossSizing : null
    if (main || cross) {
      return {
        main,
        cross,
        confidence: 1,
        reason: [`flexContainerInfo.mainSizing=${fi.mainSizing}`, `flexContainerInfo.crossSizing=${fi.crossSizing}`],
      }
    }
  }
  if (node.type === 'TEXT') {
    if (node.textMode === 'auto-height') {
      return { main: 'auto', cross: null, confidence: 1, reason: ['textMode=auto-height 高度随内容'] }
    }
    if (node.textMode === 'single-line') {
      return { main: 'fixed', cross: null, confidence: 0.8, reason: ['textMode=single-line 单行文本,高可固定'] }
    }
  }
  return {
    main: null,
    cross: null,
    confidence: 0.35,
    reason: ['无原生约束信号:按几何默认固定;若为内容容器(列表/标签/输入框)应改 auto'],
  }
}

// ---- 维度 3: 定位语义 position(流式 vs 绝对) ----
function positionOf(node, parentAbsolute) {
  const ls = node.layoutStyle || {}
  if (ls.rotate) {
    return { position: 'absolute', confidence: 1, reason: [`rotation=${round(ls.rotate)}≠0,旋转装饰层`] }
  }
  if (parentAbsolute) {
    return { position: 'absolute', confidence: 0.9, reason: ['父容器为绝对定位上下文'] }
  }
  return { position: 'flow', confidence: 0.85, reason: ['流式布局成员'] }
}

// ---- 维度 4: 间距语义 spacing(容器级) ----
function spacingOf(node) {
  const fi = node.flexContainerInfo
  const ls = node.layoutStyle || {}
  const kids = node.children || []
  const out = { gap: null, padding: null, alignItems: null, justifyContent: null, position: null, confidence: null }

  if (fi && fi.alignItems) {
    out.alignItems = fi.alignItems
    out.alignItemsConfidence = 1
  }
  // MasterGo flexContainerInfo 直读 gap/padding/justifyContent(格式 "24px 24px" / "40px"),
  // 优先于几何反推(实测 1:1 还原全部节点 ≤1px)
  if (fi && fi.gap) {
    out.gap = String(fi.gap)
    out.gapConfidence = 1
  }
  if (fi && fi.padding) {
    out.padding = String(fi.padding)
    out.paddingConfidence = 1
  }
  if (fi && fi.justifyContent) {
    out.justifyContent = fi.justifyContent
    out.justifyContentConfidence = 1
  }
  if (kids.length > 0 && ls.width && ls.height && (!fi || !fi.flexDirection)) {
    const inferred = inferLayout({
      container: { width: ls.width, height: ls.height },
      children: kids.map((k) => {
        const kls = k.layoutStyle || {}
        return {
          id: k.id,
          x: kls.relativeX ?? 0,
          y: kls.relativeY ?? 0,
          width: kls.width,
          height: kls.height,
          rotation: kls.rotate ?? 0,
        }
      }),
    })
    if (out.gap == null) out.gap = inferred.gap ?? null
    if (out.padding == null) out.padding = inferred.padding ?? null
    if (out.justifyContent == null) out.justifyContent = inferred.justifyContent ?? null
    out.position = inferred.position
    out.absolutes = inferred.absolutes ?? []
    out.confidence = inferred.confidence ?? 0
  }
  // 原生 flex 容器位置语义固定为 flow
  if (fi && fi.flexDirection) {
    out.position = "flow"
    out.positionConfidence = 1
  }
  if (!out.alignItems) out.alignItemsConfidence = 0
  return out
}

// ---- 切图决策 ----
// export-png: 位图内容(IMAGE 类型 / url()/data:image 填充),需导出切图
// code-draw: 纯色或简单渐变填充,代码可直接绘制,不切图
function renderDecisionOf(node, styles) {
  const paintStr = JSON.stringify(paintValue(styles, node.fill) ?? '')
  if (/url\(|data:image|\.png|\.jpe?g|\.webp/i.test(paintStr)) {
    return { render: 'export-png', reason: '位图内容,需导出切图' }
  }
  // 多段渐变/含阴影蒙版的复杂填充仍建议切图,简单填充走代码绘制
  const gradientStops = (paintStr.match(/gradient/gi) || []).length
  if (gradientStops > 1 || /mask/i.test(paintStr)) {
    return { render: 'export-png', reason: '复杂渐变/蒙版,代码绘制成本高,建议切图' }
  }
  return { render: 'code-draw', reason: '纯色/简单渐变,代码可直接绘制' }
}

// 切图建议文件名: 语义名 + 画板后缀(窄板 _phone / 宽板 _tablet)
function suggestAssetFileName(node, canvasWidth) {
  const base = (node.name || 'image').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '') || 'image'
  const suffix = canvasWidth != null && canvasWidth >= 700 ? '_tablet' : '_phone'
  return `${base}${suffix}.png`
}

// ---- 资产收集 ----
function collectAssets(node, styles, assets, canvasWidth) {
  const ls = node.layoutStyle || {}
  if (node.type === 'PATH' || Array.isArray(node.path)) {
    assets.inlineSvg.push({
      id: node.id,
      name: node.name || '',
      svg: svgOf(node, styles),
      viewBox: `${round(ls.width)} ${round(ls.height)}`,
    })
  }
  if (node.type === 'IMAGE' || /url\(|data:image/i.test(JSON.stringify(paintValue(styles, node.fill) ?? ''))) {
    const decision = renderDecisionOf(node, styles)
    assets.images.push({
      id: node.id,
      name: node.name || '',
      fill: paintValue(styles, node.fill),
      width: round(ls.width),
      height: round(ls.height),
      render: decision.render,
      renderReason: decision.reason,
      suggestedFileName: decision.render === 'export-png' ? suggestAssetFileName(node, canvasWidth) : null,
    })
  }
  if (node.type === 'TEXT' && Array.isArray(node.text)) {
    assets.texts.push({
      id: node.id,
      name: node.name || '',
      text: node.text.map((t) => t.text ?? '').join(''),
    })
  }
}

// ---- 重复结构(repeater)标注 ----
// 预扫描原始节点树: 同父兄弟中连续同构(结构指纹相同)且数量>=3 的段标记为重复组。
// 组内首项携带 repeat 元数据,其余项仅标 repeatItem,供 codegen 生成列表循环。
function buildRepeatMap(nodes, map) {
  for (const group of detectRepeatGroups(nodes || [])) {
    group.itemIds.forEach((id, idx) => {
      if (id == null) return
      if (idx === 0) {
        map.set(id, {
          repeat: {
            count: group.count,
            axis: group.axis,
            itemWidth: group.itemWidth,
            itemHeight: group.itemHeight,
            gap: group.gap,
            itemIds: group.itemIds,
          },
        })
      } else {
        map.set(id, { repeatItem: true, repeatOf: group.itemIds[0] })
      }
    })
  }
  for (const n of nodes || []) {
    if (n.children && n.children.length) buildRepeatMap(n.children, map)
  }
}

// ---- 递归分类 ----
function classifyNode(node, styles, stats, assets, parentAbsolute, unresolved, repeatMap, parentAbsY, canvasWidth) {
  const ls = node.layoutStyle || {}
  const kids = node.children || []
  const absY = (parentAbsY || 0) + (ls.relativeY || 0)
  stats.total++

  // 系统元素(状态栏/Home Indicator)优先于常规 kind: 生成代码时应剔除
  const sys = systemChromeOf(node, absY)
  const kind = sys || kindOf(node, styles)
  const sizing = sys
    ? { main: 'environment', cross: 'environment', confidence: 1, reason: ['系统元素,尺寸由安全区/运行环境决定'] }
    : sizingOf(node)
  const position = positionOf(node, parentAbsolute)
  const spacing = kids.length > 0 ? spacingOf(node) : null

  if (kind.kind === 'text') stats.texts++
  else if (kind.kind === 'icon') stats.icons++
  else if (kind.kind === 'image') stats.images++
  else if (kind.kind === 'container') stats.containers++
  else if (kind.kind === 'system-chrome') stats.systemChrome++
  else if (kind.kind === 'shape') stats.shapes++
  else stats.spacers++
  if (sizing.main === 'auto' || sizing.cross === 'auto') stats.autoMain++
  else if (sizing.main === 'fixed' || sizing.cross === 'fixed') stats.fixedMain++
  if (position.position === 'absolute') stats.absolute++
  else stats.flow++

  collectAssets(node, styles, assets, canvasWidth)

  // 低置信度节点收集(供 agent 询问用户 / 视觉确认)
  if (kind.kind === 'container' && sizing.main == null && sizing.cross == null) {
    unresolved.push({ id: node.id, name: node.name ?? '', type: node.type, reason: sizing.reason[0] })
  }

  const entry = {
    id: node.id,
    name: node.name ?? '',
    type: node.type,
    kind: kind.kind,
    kindConfidence: round(kind.confidence),
    kindReason: kind.reason,
    sizing: sizing.main || sizing.cross ? { main: sizing.main, cross: sizing.cross, confidence: round(sizing.confidence), reason: sizing.reason } : null,
    position: position.position,
    positionConfidence: round(position.confidence),
    positionReason: position.reason,
    spacing: spacing && (spacing.gap != null || spacing.padding != null || spacing.alignItems != null)
      ? {
          gap: spacing.gap,
          padding: spacing.padding,
          alignItems: spacing.alignItems,
          alignItemsConfidence: spacing.alignItemsConfidence ?? 0,
          justifyContent: spacing.justifyContent,
          position: spacing.position,
          absolutes: spacing.absolutes ?? [],
          geomConfidence: round(spacing.confidence ?? 0),
        }
      : null,
    confidence: round(Math.min(kind.confidence, sizing.confidence, position.confidence)),
    children: [],
  }
  const rep = repeatMap && repeatMap.get(node.id)
  if (rep) {
    if (rep.repeat) entry.repeat = rep.repeat
    else { entry.repeatItem = true; entry.repeatOf = rep.repeatOf }
  }

  // 原生 flex 语义(flexContainerInfo.flexDirection)优先于几何反推:
  // 拍平稿才允许几何反推的 absolute 覆盖。
  const abs =
    position.position === "absolute" ||
    (!(node.flexContainerInfo && node.flexContainerInfo.flexDirection) && spacing && spacing.position === "absolute");
  entry.children = classifyNodes(kids, styles, stats, assets, abs, unresolved, repeatMap, absY, canvasWidth)
  return entry
}

function classifyNodes(nodes, styles, stats, assets, parentAbsolute, unresolved, repeatMap, parentAbsY, canvasWidth) {
  const out = []
  for (const n of nodes || []) out.push(classifyNode(n, styles, stats, assets, parentAbsolute, unresolved, repeatMap, parentAbsY, canvasWidth))
  return out
}

// ---- 入口 ----
export function classifyDsl(dsl) {
  const styles = (dsl && dsl.styles) || {}
  const nodes = dsl && dsl.nodes ? dsl.nodes : Array.isArray(dsl) ? dsl : []
  const stats = {
    total: 0,
    containers: 0,
    texts: 0,
    icons: 0,
    images: 0,
    shapes: 0,
    spacers: 0,
    systemChrome: 0,
    autoMain: 0,
    fixedMain: 0,
    absolute: 0,
    flow: 0,
  }
  const assets = { inlineSvg: [], images: [], texts: [] }
  const unresolved = []
  const repeatMap = new Map()
  buildRepeatMap(nodes, repeatMap)
  // 画板宽度: 顶层节点最大宽度(用于切图 _phone/_tablet 命名建议)
  const canvasWidth = nodes.reduce((m, n) => Math.max(m, (n.layoutStyle && n.layoutStyle.width) || 0), 0) || null
  const tree = classifyNodes(nodes, styles, stats, assets, false, unresolved, repeatMap, 0, canvasWidth)
  return { stats, tree, assets, unresolved }
}

export { classifyNode, kindOf, sizingOf, positionOf, spacingOf, paintValue, resolvePaint, svgOf }
