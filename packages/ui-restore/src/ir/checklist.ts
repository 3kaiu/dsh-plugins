// ir/checklist.ts - 还原合同(实现清单): 蓝图的机器可校验消费视图之三
//
// 定位: outline 给空间心智, blueprint 给精确数值, checklist 给"实现完成与否"的判据 ——
// LLM 写码前读它拿到必须覆盖的全部事实(文本清单/组件组/矢量/位图/门禁基线),
// 写码后逐项自检, 把"遗漏"从渲染后 diff 兜底提前到编码期拦截。

import { round2 } from '../numeric.ts'

/**
 * 还原合同提取 (restorationChecklist)
 *
 * @param {object} bp generateCodeBlueprint 输出
 * @returns {{gates:object, canvas:object, scale:object|null, texts:Array, groups:Array,
 *            vectors:Array, images:Array, counts:object}}
 */
export function restorationChecklist(bp) {
  if (!bp || typeof bp !== 'object') return null
  const texts = []
  const vectorMap = new Map() // svgKey -> {name, ids:Set}
  const images = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (typeof n.text === 'string' && n.text !== '') {
      texts.push({
        id: n.id,
        text: n.text,
        bounds: n.bounds,
        fontSize: n.fontSize ?? null,
        fontWeight: n.fontWeight ?? null,
        softWrap: n.softWrap !== false,
        richRuns: Array.isArray(n.textRuns) ? n.textRuns.length : 0,
      })
    }
    if (n.svgKey) {
      if (!vectorMap.has(n.svgKey)) vectorMap.set(n.svgKey, { name: n.svgName || null, ids: new Set() })
      const entry = vectorMap.get(n.svgKey)
      if (!entry.name && n.svgName) entry.name = n.svgName
      entry.ids.add(n.id)
    } else if (n.mergedVector) {
      // 合并矢量但无 svgKey: 资源缺口, 以节点 id 为占位键列入待导出清单
      const ph = `id:${n.id}`
      if (!vectorMap.has(ph)) vectorMap.set(ph, { name: n.name || null, ids: new Set() })
      vectorMap.get(ph).ids.add(n.id)
    }
    if (n.fill && n.fill.type === 'image') {
      images.push({ id: n.id, src: n.fill.src || null, bounds: n.bounds })
    }
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c)
  }
  for (const r of [...(bp.tree || []), ...(bp.floatings || [])]) walk(r)

  return {
    gates: {
      contract: null, // 由调用方附 validateBlueprint 结果
      geometry: bp.diffReport?.verdict ?? null,
      style: bp.styleDiffReport?.verdict ?? null,
      truth: bp.truthReport?.verdict ?? null,
    },
    canvas: bp.canvas ? { width: round2(bp.canvas.width), height: round2(bp.canvas.height) } : null,
    scale: bp.canvas?.scale ?? null,
    texts,
    groups: (bp.componentGroups || []).map((g) => ({
      groupId: g.groupId,
      count: g.count,
      axis: g.axis ?? null,
      gap: g.gap != null ? g.gap : null,
      itemSize: [round2(g.itemWidth), round2(g.itemHeight)],
      instances: g.instances.map((i) => ({ id: i.id, name: i.name || '', x: round2(i.x), y: round2(i.y) })),
    })),
    vectors: [...vectorMap.entries()].map(([svgKey, { name, ids }]) => ({ svgKey, name, nodeIds: [...ids] })),
    images,
    counts: {
      texts: texts.length,
      groups: (bp.componentGroups || []).length,
      vectorKeys: vectorMap.size,
      images: images.length,
      floatings: (bp.floatings || []).length,
    },
  }
}

/**
 * 合同文本化 (checklistToText): 给 LLM 的实现前必读 + 实现后自检清单。
 * @param {object} cl restorationChecklist 输出
 * @param {object} [opts] contractOk: validateBlueprint 的布尔结果(可选附入)
 */
export function checklistToText(cl, opts = {}) {
  if (!cl) return ''
  const lines = []
  const g = cl.gates || {}
  const gateStr = [
    `几何 ${g.geometry || '?'}`,
    `样式 ${g.style || '?'}`,
    `真值 ${g.truth || '?'}`,
    opts.contractOk != null ? `契约 ${opts.contractOk ? 'PASS' : 'FAIL'}` : null,
  ].filter(Boolean).join(' | ')
  lines.push(`# 还原合同(实现前必读 / 实现后逐项自检)`)
  lines.push(`画布 ${cl.canvas ? `${round2(cl.canvas.width)}x${round2(cl.canvas.height)}` : '?'}${cl.scale ? `(原稿 ${cl.scale.factor}×已归一)` : ''} | ${gateStr}`)
  lines.push('')
  lines.push(`## 必须出现的文本 (${cl.texts.length})`)
  for (const t of cl.texts) {
    lines.push(`- "${t.text}" @(${round2(t.bounds.x)},${round2(t.bounds.y)}) ${t.fontSize ?? '?'}px${t.fontWeight ? ` w${t.fontWeight}` : ''}${t.softWrap ? '' : ' 单行'}${t.richRuns ? ` 混排x${t.richRuns}` : ''} [${t.id}]`)
  }
  if (cl.groups.length) {
    lines.push('')
    lines.push(`## 组件组 (${cl.groups.length}) — 必须实现为单组件多实例, 禁止逐份拷贝`)
    for (const grp of cl.groups) {
      const pos = grp.instances.slice(0, 4).map((i) => `@${i.x},${i.y}`).join(' ')
      lines.push(`- ${grp.groupId}: ${grp.count} 实例 ${grp.itemSize[0]}x${grp.itemSize[1]} ${pos}${grp.instances.length > 4 ? ' …' : ''}${grp.axis ? ` 排布=${grp.axis}${grp.gap != null ? ` 间距=${grp.gap}` : ''}` : ''}`)
    }
  }
  if (cl.vectors.length) {
    lines.push('')
    lines.push(`## 矢量切图 (${cl.vectors.length}) — 经资源导出表解析, 不得省略或用近似图形替代; id: 前缀为待导出资源(按节点 id 从设计侧补切图)`)
    for (const v of cl.vectors) lines.push(`- ${v.svgKey} ← [${v.nodeIds.join(', ')}]${v.svgName ? ` (${v.svgName})` : ''}`)
  }
  if (cl.images.length) {
    lines.push('')
    lines.push(`## 位图引用 (${cl.images.length}) — src 为空时按节点 id 从设计侧导出`)
    for (const im of cl.images) lines.push(`- [${im.id}] ${im.src || '(待导出)'}`)
  }
  lines.push('')
  lines.push(`## 自检: 上列 ${cl.counts.texts} 文本/${cl.counts.groups} 组件组/${cl.counts.vectorKeys} 矢量/${cl.counts.images} 位图 全部落地后, 才进入渲染验证(ui-restore diff)`)
  return lines.join('\n')
}
