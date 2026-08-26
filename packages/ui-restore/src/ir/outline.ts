// ir/outline.ts - 蓝图双表征之二: outline 文本 + 消费指南
//
// blueprint.json 是无损精确表征; outline 是给 LLM 快速建立空间心智的
// 紧凑文本表征(缩进树 + 逐节点一行摘要), 亦是人类评审产物可读性的界面。
// 两者同源生成, 永不冲突。

const round1 = (n) => Math.round((n || 0) * 100) / 10 / 10

/** 单节点一行摘要 */
function nodeSummary(n) {
  const ly = n.layout || {}
  const b = n.bounds || {}
  const parts = []
  parts.push(`[${ly.role || 'box'}${ly.position === 'absolute' ? ':abs' : ''}]`)
  parts.push(n.name || n.type || 'node')
  parts.push(`@(${round1(b.x)},${round1(b.y)} ${round1(b.width)}x${round1(b.height)})`)
  if (n.color) parts.push(n.color)
  if (n.fill) {
    if (n.fill.type === 'gradient') parts.push(`渐变:${(n.fill.stops || []).map((s) => s.color).join('→')} ${n.fill.angle ?? ''}°`.trim())
    else if (n.fill.type === 'image') parts.push(`位图:${n.fill.src || '经资源导出表按节点id'}`)
  }
  if (n.stroke) parts.push(`描边:${n.stroke.color || '?'} ${n.stroke.width != null ? n.stroke.width + 'px' : ''}${n.stroke.style ? ' ' + n.stroke.style : ''}`.trim())
  if (n.rotation) parts.push(`旋转${n.rotation}°`)
  if (n.opacity != null) parts.push(`透明度${n.opacity}`)
  if (n.text != null && n.text !== '') parts.push(`"${String(n.text).slice(0, 24)}" ${n.fontSize ?? '?'}px${n.fontWeight ? ` w${n.fontWeight}` : ''}${n.softWrap === false ? ' 单行' : ''}${Array.isArray(n.textRuns) ? ` 混排x${n.textRuns.length}` : ''}${n.measured?.singleLineWidth != null ? ` 实测宽${n.measured.singleLineWidth}` : ''}`)
  if (n.svgKey) parts.push(`svg:${n.svgKey}${n.svgName ? `(${n.svgName})` : ''}`)
  if (typeof ly.gap === 'number' && ly.gap > 0) parts.push(`gap=${round1(ly.gap)}`)
  if (Array.isArray(ly.gap)) parts.push(`gap[]=${ly.gap.map(round1).join(',')}`)
  const pad = ly.padding
  if (Array.isArray(pad) && pad.some(v => v > 0)) parts.push(`pad=${pad.map(round1).join(',')}`)
  if (ly.justifyContent && ly.justifyContent !== 'start') parts.push(`just=${ly.justifyContent}`)
  if (ly.alignItems && ly.alignItems !== 'start') parts.push(`align=${ly.alignItems}`)
  if (ly.crossOffset) parts.push(`crossOff=${round1(ly.crossOffset)}`)
  if (ly.borderRadius) parts.push(`r=${Array.isArray(ly.borderRadius) ? ly.borderRadius.join('/') : ly.borderRadius}`)
  if (ly.effects?.some((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')) parts.push('阴影')
  if (ly.downgradeReason) parts.push(`(降级:${ly.downgradeReason})`)
  return parts.join(' ')
}

/**
 * 消费指南(固定文本): 蓝图字段的语义约定。
 * LLM 无需读算法源码, 按本指南即可正确消费蓝图。
 */
export function restorationGuide(bp) {
  const canvas = bp.canvas || {}
  return [
    '## 消费指南(蓝图字段语义)',
    '- layout.role: row|column|stack|box; stack 子项按 bounds 差值绝对定位',
    '- 缺省约定: justifyContent/alignItems 缺省=start; gap 缺省=0; padding 缺省=[0,0,0,0]; 字段缺省即为该值',
    '- layout.gap: 数值=主轴等距; 数组=相邻子项逐对间距(可为负=重叠, 用逐项偏移实现)',
    '- layout.padding: [top, right, bottom, left] 逻辑像素',
    '- bounds 为画布绝对坐标且是尺寸唯一真值; 子项相对位置 = 子 bounds - 父 bounds',
    '- 层级约定: floatings 渲染在 tree 之上(顶层悬浮层); stack 内子项按数组序自下而上叠加(z 序)',
    '- 文字: softWrap=false 禁止换行(单行语义); measured.singleLineWidth 为实测宽度; textRuns 存在时为富文本混排, 逐 run 样式优先于整串字段',
    `- 尺寸/坐标单位均为逻辑像素; 颜色 #RRGGBB(AA); rotation 单位度; opacity 0~1`,
    '- fill.type=gradient: {kind, angle(度), stops:[{color, position(%)}]}; fill.type=image: src 或经资源导出表按节点 id 取位图',
    '- stroke: {color, width, align(inside/center/outside), style}; 圆角在 layout.borderRadius; 阴影在 layout.effects',
    '- svgKey: 矢量切图引用, 经资源导出表(节点 id -> svg)解析; 命中导出表的节点渲染矢量并叠加文字子树',
    '- designTokens: 颜色/字号等已去重为 DTCG token, 优先引用 token 而非裸值',
    '- componentGroups: 同构兄弟组, 必须实现为单个组件的多个实例(禁止逐份拷贝)',
    '- styleDiffReport.verdict 必须为 PASS_STYLE_CONSERVED, 否则蓝图样式通道有丢失, 勿直接消费',
    `- canvas.scale 存在时: 原稿为 factor 倍画板(@2x/@3x), 蓝图全部数值已归一为逻辑像素; 缺省即原样坐标`,
    `- 画布: ${round1(canvas.width)}x${round1(canvas.height)}; 产线实现请按目标技术栈做分辨率适配`,
  ].join('\n')
}

/**
 * 蓝图 → outline 文本 (blueprintToOutline)
 * @param {object} bp generateCodeBlueprint 输出
 * @param {object} [opts] includeGuide: 附消费指南(默认 true); maxDepth: 最大缩进深度
 * @returns {string}
 */
export function blueprintToOutline(bp, opts = {}) {
  if (!bp) return ''
  const maxDepth = opts.maxDepth ?? 12
  const lines = []
  let count = 0
  const walk = (n, depth) => {
    if (!n || depth > maxDepth) return
    count++
    lines.push('  '.repeat(depth) + nodeSummary(n))
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, depth + 1)
  }
  lines.push(`# UI 还原蓝图 outline (画布 ${round1(bp.canvas?.width)}x${round1(bp.canvas?.height)})`)
  for (const r of bp.tree || []) walk(r, 0)
  if ((bp.floatings || []).length > 0) {
    lines.push('# 悬浮层')
    for (const r of bp.floatings) walk(r, 0)
  }
  if ((bp.componentGroups || []).length > 0) {
    lines.push('# 组件组(同构兄弟, 实现为单组件多实例)')
    for (const g of bp.componentGroups) {
      const pos = g.instances.slice(0, 4).map((i) => `@${round1(i.x)},${round1(i.y)}`).join(' ')
      lines.push(`${g.groupId}: ${g.count} 个实例 ${round1(g.itemWidth)}x${round1(g.itemHeight)} ${pos}${g.instances.length > 4 ? ' …' : ''}${g.axis ? ` 排布=${g.axis}${g.gap != null ? ` 间距=${round1(g.gap)}` : ''}` : ''} — ids: ${g.instances.map(i => i.id).join(', ')}`)
    }
  }
  if (opts.includeGuide !== false) {
    lines.push('')
    lines.push(restorationGuide(bp))
  }
  return lines.join('\n')
}
