// ir/outline.ts - 蓝图双表征之二: outline 文本 + 消费指南
//
// blueprint.json 是无损精确表征; outline 是给 LLM 快速建立空间心智的
// 紧凑文本表征(缩进树 + 逐节点一行摘要), 亦是人类评审产物可读性的界面。
// 两者同源生成, 永不冲突。

import { round2 } from '../numeric.ts'

/** 单节点一行摘要 */
function nodeSummary(n: any) {
  const ly = n.layout || {}
  const b = n.bounds || {}
  const parts = []
  parts.push(`[${ly.role || 'box'}${ly.position === 'absolute' ? ':abs' : ''}]`)
  parts.push(n.name || n.type || 'node')
  parts.push(`@(${round2(b.x)},${round2(b.y)} ${round2(b.width)}x${round2(b.height)})`)
  if (n.color) parts.push(n.color)
  if (n.fill) {
    if (n.fill.type === 'gradient') parts.push(`渐变:${(n.fill.stops || []).map((s: any) => s.color).join('→')} ${n.fill.angle ?? ''}°`.trim())
    else if (n.fill.type === 'image') parts.push(`位图:${n.fill.src || '经资源导出表按节点id'}${n.fill.crop ? ` cover→${n.fill.crop.visibleRect.width}x${n.fill.crop.visibleRect.height}` : ''}`)
  }
  if (n.stroke) parts.push(`描边:${n.stroke.color || '?'} ${n.stroke.width != null ? n.stroke.width + 'px' : ''}${n.stroke.style ? ' ' + n.stroke.style : ''}`.trim())
  if (n.rotation) parts.push(`旋转${n.rotation}°`)
  if (n.opacity != null) parts.push(`透明度${n.opacity}`)
  if (n.text != null && n.text !== '') parts.push(`"${String(n.text).slice(0, 24)}" ${n.fontSize ?? '?'}px${n.fontWeight ? ` w${n.fontWeight}` : ''}${n.softWrap === false ? ' 单行' : ''}${Array.isArray(n.textRuns) ? ` 混排x${n.textRuns.length}` : ''}${n.measured?.singleLineWidth != null ? ` 实测宽${n.measured.singleLineWidth}` : ''}`)
  if (n.svgKey) parts.push(`svg:${n.svgKey}${n.svgName ? `(${n.svgName})` : ''}`)
  else if (n.mergedVector) parts.push('合并矢量(待按id导出)')
  if (n.contentClipped) parts.push(`内容被裁(实际${round2(n.contentClipped.width)}x${round2(n.contentClipped.height)})`)
  if (typeof ly.gap === 'number' && ly.gap > 0) parts.push(`gap=${round2(ly.gap)}`)
  if (Array.isArray(ly.gap)) parts.push(`gap[]=${ly.gap.map(round2).join(',')}`)
  const pad = ly.padding
  if (Array.isArray(pad) && pad.some(v => v > 0)) parts.push(`pad=${pad.map(round2).join(',')}`)
  if (ly.justifyContent && ly.justifyContent !== 'start') parts.push(`just=${ly.justifyContent}`)
  if (ly.alignItems && ly.alignItems !== 'start') parts.push(`align=${ly.alignItems}`)
  if (ly.crossOffset) parts.push(`crossOff=${round2(ly.crossOffset)}`)
  if (ly.borderRadius) parts.push(`r=${Array.isArray(ly.borderRadius) ? ly.borderRadius.join('/') : ly.borderRadius}`)
  if (ly.effects?.some((e: any) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')) parts.push('阴影')
  if (ly.downgradeReason) parts.push(`(降级:${ly.downgradeReason})`)
  if (ly.clip?.enabled) parts.push(`裁剪${ly.clip.radius != null ? `(r=${Array.isArray(ly.clip.radius) ? ly.clip.radius.join('/') : ly.clip.radius})` : ''}`)
  if (n.clipShape) parts.push('蒙版形状')
  // 仅标注低置信 flex 推断(需以 bounds 复核); stack 差值定位天然可靠, 不标
  if (ly.position !== 'absolute' && ly.confidence != null && ly.confidence <= 0.7) parts.push(`conf=${ly.confidence}`)
  return parts.join(' ')
}

/**
 * 消费指南(固定文本): 蓝图字段的语义约定。
 * LLM 无需读算法源码, 按本指南即可正确消费蓝图。
 */
export function restorationGuide(bp: any) {
  const canvas = bp.canvas || {}
  return [
    '## 消费指南(蓝图字段语义)',
    '- layout.role: row|column|stack|box; stack 子项按 bounds 差值绝对定位',
    '- layout.confidence: 布局推理置信度 0~1(算法推断, 非设计稿数据); position=absolute 是正常决策(stack 差值定位), 不是失败态; flex 且 confidence<0.7 时建议以 bounds 复核子项位置',
    '- layout.reason: 该布局判定的依据摘要(如 "row(顶对齐)+等间距"、"flex模拟偏差>2px,降级保真")',
    '- 缺省约定: justifyContent/alignItems 缺省=start; gap 缺省=0; padding 缺省=[0,0,0,0]; 字段缺省即为该值',
    '- layout.gap: 数值=主轴等距; 数组=相邻子项逐对间距(可为负=重叠, 用逐项偏移实现)',
    '- layout.padding: [top, right, bottom, left] 逻辑像素',
    '- bounds 为画布绝对坐标且是尺寸唯一真值; 子项相对位置 = 子 bounds - 父 bounds',
    '- 层级约定: floatings 渲染在 tree 之上(顶层悬浮层); stack 内子项按数组序自下而上叠加(z 序)',
    '- 文字: softWrap=false 禁止换行(单行语义); measured.singleLineWidth 为实测宽度; textRuns 存在时为富文本混排, 逐 run 样式优先于整串字段',
    '- measured.fontConfidence/fontNote: declared 字号与实测文本宽×框高的交叉验证; confidence<0.5 或 fontNote 提示时, 以 bounds 高度反推字号核对(装饰字体: 字号≈框高)',
    `- 尺寸/坐标单位均为逻辑像素; 颜色 #RRGGBB(AA); rotation 单位度; opacity 0~1`,
    '- fill.type=gradient: {kind, angle(度), stops:[{color, position(%)}]}; fill.type=image: src 或经资源导出表按节点 id 取位图',
    '- fill.crop{mode:cover, visibleRect}: 位图节点 bounds 是原始素材尺寸, 实际仅 visibleRect(本节点坐标系)可见 — 把素材等比缩放(取覆盖 visibleRect 的比例)居中后只显示该区域',
    '- stroke: {color, width, align(inside/center/outside), style}; 圆角在 layout.borderRadius; 阴影在 layout.effects',
    '- layout.clip{enabled,source,radius}: 该节点是蒙版裁剪边界(矩形=bounds, 圆角=radius), 原始设计分组内叠于其上的兄弟内容渲染时被它裁剪; clipShape=true 表示该节点本身只是形状定义而非可见内容, 勿绘制其填充',
    '- contentClipped{width,height}: 本节点 bounds 是裁剪后的显示框, 子项真实外接盒更大 — 布局以子项 bounds 为准实现, 本节点只作可视窗口',
    '- svgKey: 矢量切图引用, 经资源导出表(节点 id -> svg)解析; 命中导出表的节点渲染矢量并叠加文字子树',
    '- mergedVector=true: 合并矢量图标(整组即一个资源); 若同时无 svgKey, 该资源缺失, 必须按节点 id 从设计侧导出后渲染, 不得留空或用形状近似替代',
    '- 事实纪律: 蓝图全部数值(bounds/gap/padding/fontSize/color...)是设计稿测量事实, 禁止修改、取整或凭感觉"合理化"; 存疑时以 bounds 差值复核, 不改数',
    '- 大页面按区域消费: 先读本指南与 outline 建立空间心智, 再用 blueprintRegion(bp,{x,y,width,height}|{ids}) 下钻目标区域子树, 避免整页蓝图全量进上下文',
    '- designTokens: 颜色/字号等已去重为 DTCG token, 优先引用 token 而非裸值',
    '- componentGroups: 同构兄弟组, 必须实现为单个组件的多个实例(禁止逐份拷贝)',
    '- styleDiffReport.verdict 必须为 PASS_STYLE_CONSERVED, 否则蓝图样式通道有丢失, 勿直接消费',
    `- canvas.scale 存在时: 原稿为 factor 倍画板(@2x/@3x), 蓝图全部数值已归一为逻辑像素; 缺省即原样坐标`,
    `- 画布: ${round2(canvas.width)}x${round2(canvas.height)}; 产线实现请按目标技术栈做分辨率适配`,
  ].join('\n')
}

/**
 * 区域下钻 (blueprintRegion): 从蓝图中提取与目标区域相关的子树 —— P3 Context 分层的下钻入口。
 * 大页面先读 outline 建立空间心智, 对要实现/修正的区域下钻拿完整精确子树,
 * 避免整页蓝图全量进上下文。命中节点整棵子树纳入; 仅祖先命中的保留祖先链。
 *
 * @param {object} bp generateCodeBlueprint 输出
 * @param {object} sel {x,y,width,height}(画布绝对矩形, 与 bounds 相交即命中) | {ids:[...]}(节点 id 白名单)
 * @returns {{sel, canvas, nodes:Array, count:number}|null}
 */
export function blueprintRegion(bp: any, sel: any) {
  if (!bp || !sel) return null;
  const idSet = Array.isArray(sel.ids) ? new Set(sel.ids.map(String)) : null;
  const rect = sel.width != null && sel.height != null ? sel : null;
  const hit = (n: any) => {
    if (idSet) return idSet.has(String(n.id));
    if (!rect || !n.bounds) return false;
    const b = n.bounds;
    return b.x < rect.x + rect.width && b.x + b.width > rect.x && b.y < rect.y + rect.height && b.y + b.height > rect.y;
  };
  let total = 0;
  const countAll = (n: any) => { total++; for (const c of n.children || []) countAll(c); };
  const pick = (n: any) => {
    if (hit(n)) { const cp = structuredClone(n); return cp; }
    const kids = [];
    for (const c of n.children || []) {
      const p = pick(c);
      if (p) kids.push(p);
    }
    if (!kids.length) return null;
    const cp = structuredClone({ ...n, children: [] });
    cp.children = kids;
    return cp;
  };
  const roots = [...(bp.tree || []), ...(bp.floatings || [])]
    // 合成页面壳(page_shell)覆盖全画布, 直接判定会让任意矩形命中整页 — 剥壳后按其子树分别判定
    .flatMap((r) => (r.isSyntheticGroup && Array.isArray(r.children) ? r.children : [r]))
    .map(pick).filter(Boolean);
  roots.forEach(countAll);
  return { sel: structuredClone(sel), canvas: bp.canvas ? { ...bp.canvas } : null, nodes: roots, count: total };
}

/**
 * 蓝图 → outline 文本 (blueprintToOutline)
 * @param {object} bp generateCodeBlueprint 输出
 * @param {object} [opts] includeGuide: 附消费指南(默认 true); maxDepth: 最大缩进深度
 * @returns {string}
 */
export function blueprintToOutline(bp, opts: Record<string, any> = {}) {
  if (!bp) return ''
  const maxDepth = opts.maxDepth ?? 12
  const lines = []
  let count = 0
  const walk = (n: any, depth: any) => {
    if (!n || depth > maxDepth) return
    count++
    lines.push('  '.repeat(depth) + nodeSummary(n))
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, depth + 1)
  }
  lines.push(`# UI 还原蓝图 outline (画布 ${round2(bp.canvas?.width)}x${round2(bp.canvas?.height)})`)
  for (const r of bp.tree || []) walk(r, 0)
  if ((bp.floatings || []).length > 0) {
    lines.push('# 悬浮层')
    for (const r of bp.floatings) walk(r, 0)
  }
  if ((bp.componentGroups || []).length > 0) {
    lines.push('# 组件组(同构兄弟, 实现为单组件多实例)')
    for (const g of bp.componentGroups) {
      const pos = g.instances.slice(0, 4).map((i: any) => `@${round2(i.x)},${round2(i.y)}`).join(' ')
      lines.push(`${g.groupId}: ${g.count} 个实例 ${round2(g.itemWidth)}x${round2(g.itemHeight)} ${pos}${g.instances.length > 4 ? ' …' : ''}${g.axis ? ` 排布=${g.axis}${g.gap != null ? ` 间距=${round2(g.gap)}` : ''}` : ''} — ids: ${g.instances.map(i => i.id).join(', ')}`)
    }
  }
  if (opts.includeGuide !== false) {
    lines.push('')
    lines.push(restorationGuide(bp))
  }
  return lines.join('\n')
}
