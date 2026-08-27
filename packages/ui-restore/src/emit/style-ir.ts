// emit/style-ir.ts — Strategy IR: 蓝图 + Generation Contract + 资产解析 → 目标无关元素树
//
// v4 §5: 「先生成统一 Style IR, 再序列化为目标样式」。本模块是唯一把蓝图语义
// (bounds/role/fill/effects/text)翻译成 CSS 事实的地方; react.ts / html.ts 两个
// serializer 只做语法变换, 不再各自解释蓝图 —— 消除双实现漂移。
//
// 保真清单(V1 必须正确处理, 见 v4 §5):
//   absolute/stack→position:absolute | clip→overflow:hidden+精确尺寸(高风险①)
//   fill.gradient→linear-gradient | fill.image+crop→cover 映射(经 asset-resolver 共享实现)
//   effects→box-shadow | borderRadius 数组→四角 | svgKey→内联矢量(高风险②, 缺失=占位+违约)
//   textRuns/softWrap/maxLines | opacity/rotation
export interface TextRunIR {
  text: string
  style: Record<string, string | number>
}

/** Strategy IR 元素(目标无关) */
export interface ElementNode {
  tag: string
  nodeId: string
  name?: string
  attrs: Record<string, string | number>
  /** camelCase CSS 属性(React inline style 直接可用) */
  style: Record<string, string | number>
  text?: string
  textRuns?: TextRunIR[]
  /** svgKey 已解析时的内联矢量原文 */
  rawSvg?: string
  /** 资产违约标记(missing) — gate 侧据此计 STRUCTURE/ASSET 违约 */
  assetMissing?: string
  children: ElementNode[]
  /** 生成文件中的行号(serializer 回填) */
  line?: number
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)

function gradientCss(fill) {
  const stops = (fill.stops || []).map((s) => `${s.color} ${num(s.position)}%`).join(', ')
  return `linear-gradient(${num(fill.angle)}deg, ${stops})`
}

function borderRadiusCss(radius) {
  if (radius == null) return undefined
  if (typeof radius === 'number') return radius
  if (Array.isArray(radius)) {
    const [tl, tr, br, bl] = radius.length === 4 ? radius : [radius[0], radius[0], radius[0], radius[0]]
    return `${num(tl)}px ${num(tr)}px ${num(br)}px ${num(bl)}px`
  }
  return undefined
}

function boxShadowCss(effects) {
  if (!Array.isArray(effects) || !effects.length) return undefined
  // 仅阴影类生效；LAYER_BLUR/BACKGROUND_BLUR 单独走 filter/backdrop-filter(见 buildElementTree)
  const parts = effects
    .filter((e) => e.type === 'INNER_SHADOW' || e.type === 'DROP_SHADOW')
    .map((e) => {
      const inset = e.type === 'INNER_SHADOW' ? 'inset ' : ''
      return `${inset}${num(e.offsetX)}px ${num(e.offsetY)}px ${num(e.blur)}px ${num(e.spread)}px ${e.color}`
    })
  return parts.length ? parts.join(', ') : undefined
}

/** 把 alpha 烘焙进 CSS 颜色(#rgb/#rrggbb/#rrggbbaa/rgb()/rgba())，避免整树透明度泄漏到子元素 */
function withAlpha(cssColor, alpha) {
  if (typeof cssColor !== 'string') return cssColor
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(cssColor.trim())
  if (m) {
    let hex = m[1]
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
    if (hex.length === 6) hex += 'ff'
    if (hex.length !== 8) return cssColor // 非标准长度(4/5/7 位)原样返回, 避免 NaN
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16)
    const a = (parseInt(hex.slice(6, 8), 16) / 255) * alpha
    return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`
  }
  const rm = /^rgba?\(([^)]+)\)$/.exec(cssColor.trim())
  if (rm) {
    const p = rm[1].split(',').map((s) => s.trim())
    const baseA = p[3] != null ? parseFloat(p[3]) : 1
    return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${Math.round(baseA * alpha * 1000) / 1000})`
  }
  return cssColor
}

/** 容器透明度烘焙：把 frame opacity 仅作用于背景（solid/gradient），子代保持不透明 */
function backgroundWithOpacity(n, opacity) {
  if (n.fill?.type === 'solid') return withAlpha(n.fill.value, opacity)
  if (n.fill?.type === 'gradient') {
    const stops = (n.fill.stops || []).map((s) => `${withAlpha(s.color, opacity)} ${num(s.position)}%`).join(', ')
    return `linear-gradient(${num(n.fill.angle)}deg, ${stops})`
  }
  return null
}

function typographyStyle(n, fontStack) {
  const s = {}
  if (n.fontSize != null) s.fontSize = num(n.fontSize)
  if (n.fontWeight != null) s.fontWeight = n.fontWeight
  s.lineHeight = n.lineHeight != null ? num(n.lineHeight) : num((n.fontSize ?? 14) * 1.4)
  if (n.letterSpacing != null) s.letterSpacing = n.letterSpacing
  if (n.color) s.color = n.color
  if (n.textAlign) s.textAlign = n.textAlign
    s.fontFamily = fontStack
  if (n.softWrap === false) s.whiteSpace = 'nowrap'
  else s.overflowWrap = 'break-word' // 拉丁文按词折行(CJK 默认按字折行, 避免 break-all 切断单词)
  if (n.maxLines != null && n.maxLines > 0) {
    s.display = '-webkit-box'
    s.WebkitBoxOrient = 'vertical'
    s.WebkitLineClamp = n.maxLines
    s.overflow = 'hidden'
    s.textOverflow = 'ellipsis'
    s.whiteSpace = 'normal'
  }
  return s
}

export interface EmitContext {
  /** nodeId → GenerationContractItem */
  contractById: Map<string, any>
  /** nodeId → resolveAssets.assets[] 条目(svg/image) */
  assetByNode: Map<string, any>
  /** 字体栈字符串: 'PingFang SC','Helvetica Neue',... */
  fontStack: string
}

/**
 * 蓝图 → Strategy IR 元素树。
 * @param {object} bp 蓝图({canvas,tree,floatings,backgrounds})
 * @param {EmitContext} ctx
 */
export function buildElementTree(bp, ctx) {
  const roots = []
  // 页面级背景层(蓝图单独输出, z 序在最下)
  for (const bg of Array.isArray(bp.backgrounds) ? bp.backgrounds : []) {
    const b = bg.bounds || {}
    roots.push({
      tag: 'div', nodeId: bg.id, name: bg.name,
      attrs: { 'data-restore-node': bg.id, 'data-restore-layer': 'background' },
      style: {
        position: 'absolute', left: num(b.x), top: num(b.y),
        width: num(b.width) || undefined, height: num(b.height) || undefined,
        background: bg.fill?.type === 'gradient' ? gradientCss(bg.fill)
          : bg.fill?.type === 'solid' ? bg.fill.value
          : (bg.color ?? undefined),
      },
      children: [],
    })
  }
  const emitNode = (n, parentAbs, parentFlex) => {
    const c = ctx.contractById.get(n.id) || {}
    const b = n.bounds || { x: 0, y: 0, width: 0, height: 0 }
    const ly = n.layout || {}
    const style = {}
    const children = []

    // ---- 定位策略(唯一决策点: contract.layout.strategy) ----
    if (parentFlex) {
      style.position = 'relative' // flow 子项: 间距由父级 flex 循环以 margin 兑现
    } else {
      style.position = 'absolute'
      style.left = num(b.x) - num(parentAbs.x)
      style.top = num(b.y) - num(parentAbs.y)
    }
    style.width = num(b.width)
    style.height = num(b.height)

    // ---- flex 容器 ----
    // 间距纪律: 不发 gap/padding/justify —— 一律由下方逐子项 margin 从 bounds 精确兑现
    // (蓝图允许负 gap 模拟重叠, CSS gap 属性非法; margin 方案可正可负, 且防 margin+gap 双重补偿)。
    // flex 语义保留在 DOM 结构(display/flexDirection), 语义化间距是后续 Semantic 阶段的事。
    if (c.layout?.strategy === 'flex') {
      style.display = 'flex'
      style.flexDirection = ly.role === 'row' ? 'row' : 'column'
    }

    // ---- 裁剪(高风险①): clip / contentClipped → overflow:hidden + 精确尺寸 ----
    if (c.container?.clip === 'overflow-hidden' || n.contentClipped || ly.clip?.enabled) style.overflow = 'hidden'

    // ---- 绘制 ----
    if (n.fill?.type === 'gradient') style.background = gradientCss(n.fill)
    else if (n.fill?.type === 'solid') style.background = n.fill.value
    else if (n.color && n.type !== 'TEXT' && !n.svgKey && !n.fill) style.background = n.color
    if (n.fill?.type === 'image') {
      const a = ctx.assetByNode.get(n.id)
      if (a?.status === 'resolved') {
        Object.assign(style, imageBackgroundInline(n.fill, b, a.file))
      } else {
        style.background = '#CFCFCF' // 位图无导出源: 灰块占位, 违约由 gate 依 assets.summary 计
      }
    }
    const radius = borderRadiusCss(ly.borderRadius ?? n.borderRadius)
    if (radius != null) style.borderRadius = radius
    const shadow = boxShadowCss(ly.effects)
    if (shadow) style.boxShadow = shadow
    // 模糊/磨砂层: LAYER_BLUR → filter:blur(装饰光晕/虚化); BACKGROUND_BLUR → backdrop-filter(毛玻璃)
    // 此前被 boxShadowCss 忽略(甚至生成无效阴影串), 现单独处理
    for (const e of (ly.effects || [])) {
      if (e.type === 'LAYER_BLUR') {
        style.filter = `blur(${num(e.blur)}px)`
      } else if (e.type === 'BACKGROUND_BLUR') {
        style.backdropFilter = `blur(${num(e.blur)}px)`
        style.webkitBackdropFilter = `blur(${num(e.blur)}px)`
        // 毛玻璃需半透明底才可见, 无 solid/gradient 背景时补一层半透明兜底
        if (!style.background && n.fill?.type !== 'solid' && n.fill?.type !== 'gradient') style.background = 'rgba(255,255,255,0.5)'
      }
    }
    if (n.stroke?.color && num(n.stroke.width) > 0) style.border = `${num(n.stroke.width)}px ${n.stroke.style || 'solid'} ${n.stroke.color}`
    // 透明度：容器(含子元素)必须把 alpha 烘焙进背景，否则整棵子树被淡化（设计规则：frame opacity 仅作用于背景）
    if (n.opacity != null && n.opacity !== 1) {
      const containerWithChildren = Array.isArray(n.children) && n.children.length > 0
      if (containerWithChildren && (n.fill?.type === 'solid' || n.fill?.type === 'gradient')) {
        style.background = backgroundWithOpacity(n, n.opacity)
      } else if (!containerWithChildren) {
        // 叶子: 整元素淡化(含背景/文本); 含子元素但无背景: 按规则不淡化子代, 保持不透明
        style.opacity = n.opacity
      }
    }
    if (n.rotation) style.transform = `rotate(${num(n.rotation)}deg)`

    const el = {
      tag: 'div',
      nodeId: n.id,
      name: n.name,
      attrs: { 'data-restore-node': n.id },
      style,
      children,
    }

    // ---- 文本 ----
    if (typeof n.text === 'string' && n.text) {
      el.style = { ...el.style, ...typographyStyle(n, ctx.fontStack) }
      if (Array.isArray(n.textRuns) && n.textRuns.length) {
        el.textRuns = n.textRuns.map((r) => ({
          text: r.text,
          style: {
            ...(r.fontSize != null ? { fontSize: num(r.fontSize) } : {}),
            ...(r.fontWeight != null ? { fontWeight: r.fontWeight } : {}),
            ...(r.lineHeight != null ? { lineHeight: num(r.lineHeight) } : {}),
            ...(r.letterSpacing != null ? { letterSpacing: r.letterSpacing } : {}),
          },
        }))
      } else {
        el.text = n.text
      }
      return el
    }

    // ---- 矢量(高风险②): 已解析=内联; 缺失=几何占位+违约标记 ----
    // 含 mergedVector(无 svgKey, 按节点 id 反查) —— 同样不可近似替代
    if (n.svgKey || (n as any).mergedVector) {
      const key = n.svgKey || n.id
      const a = ctx.assetByNode.get(n.id) || ctx.assetByNode.get(key)
      if (a?.status === 'resolved' && (a.rawSvg || a.svg)) el.rawSvg = a.rawSvg || a.svg
      else {
        el.style.background = el.style.background || '#C9D0DD'
        el.assetMissing = key
      }
      return el
    }

    // ---- flex 子项的 margin 兑现(flow 保几何, 带符号: 负 gap 模拟重叠同样成立) ----
    if (c.layout?.strategy === 'flex' && Array.isArray(n.children) && n.children.length) {
      const isRow = ly.role === 'row'
      let cursor = isRow ? num(b.x) : num(b.y)
      for (const child of n.children) {
        const childEl = emitNode(child, b, true)
        const cb = child.bounds || { x: 0, y: 0, width: 0, height: 0 }
        // 防止 flex 算法压缩子项显式宽度: 固定不伸缩(flex 容器自身定主轴)
        childEl.style.flexShrink = 0
        childEl.style.flexGrow = 0
        // 主轴: cursor 递进兑现间距(带符号); 交叉轴: 相对父 bounds 的偏移一次兑现
        const main = (isRow ? num(cb.x) : num(cb.y)) - cursor
        const cross = isRow ? num(cb.y) - num(b.y) : num(cb.x) - num(b.x)
        if (isRow) {
          if (Math.abs(main) > 0.005) childEl.style.marginLeft = round2(main)
          if (Math.abs(cross) > 0.005) childEl.style.marginTop = round2(cross)
        } else {
          if (Math.abs(main) > 0.005) childEl.style.marginTop = round2(main)
          if (Math.abs(cross) > 0.005) childEl.style.marginLeft = round2(cross)
        }
        cursor = isRow ? num(cb.x) + num(cb.width) : num(cb.y) + num(cb.height)
        children.push(childEl)
      }
      return el
    }

    for (const ch of n.children || []) children.push(emitNode(ch, b, false))
    return el
  }
  for (const r of bp?.tree || []) roots.push(emitNode(r, { x: 0, y: 0 }, false))
  // floatings 在 tree 之上(z 序: DOM 顺序天然后画在上)
  for (const r of bp?.floatings || []) roots.push(emitNode(r, { x: 0, y: 0 }, false))
  return roots
}

/** image+crop → inline style(引用 asset-resolver 共享映射, 防两处实现漂移) */
function imageBackgroundInline(fill, bounds, file) {
  // 直接复用 asset-resolver 的映射语义(src 换成本地 file)
  const px = fill.crop ? ((fill.crop.visibleRect.x + fill.crop.visibleRect.width / 2) / Math.max(1, bounds.width)) * 100 : 50
  const py = fill.crop ? ((fill.crop.visibleRect.y + fill.crop.visibleRect.height / 2) / Math.max(1, bounds.height)) * 100 : 50
  return {
    backgroundImage: `url(${file})`,
    backgroundSize: fill.crop ? 'cover' : '100% 100%',
    backgroundPosition: `${round2(Math.min(100, Math.max(0, px)))}% ${round2(Math.min(100, Math.max(0, py)))}%`,
    backgroundRepeat: 'no-repeat',
  }
}

/** camelCase style → CSS 声明串(HTML serializer 用; React 直接用对象) */
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flexGrow', 'flexShrink', 'order', 'WebkitLineClamp'])
export function styleToCssDeclarations(style) {
  const kebab = (k) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
  return Object.entries(style)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      const val = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v
      return `${kebab(k)}:${val}`
    })
    .join(';')
}

const round2 = (n) => Math.round(n * 100) / 100
