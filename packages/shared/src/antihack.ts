'use strict'
// anti_hack_scan：静态反 hack 扫描（§8.1 规则表驱动）
// 输入：{ projectPath, domDump, reference, treeStats, codeStats }
// - domDump：browser_dom_dump 输出（含 tree + issues）
// - reference：blueprint 摘要（含 tree / stats.absolute 占比）
// - treeStats：page_layout_tree 的 stats（total/containers/flex/absolute）
// - codeStats：可选的仓库静态扫描结果（inlineStyleCount/importantCount/negativeMargins/mediaQuery等），若未提供则仅基于 DOM
// 输出：{ violations: [{rule, value, threshold, severity, reason}], warnings: [...] , passed: boolean }

function countNodes(tree: any, predicate: any) {
  let c = 0
  const walk = (nodes: any) => {
    for (const n of nodes) {
      if (predicate(n)) c++
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree])
  return c
}
function flatten(tree: any): any[] {
  const out: any[] = []
  const walk=(nodes: any)=>{ for(const n of nodes){ out.push(n); if(n.children) walk(n.children)}}
  walk(Array.isArray(tree)?tree:[tree])
  return out
}

export function antiHackScan({ domDump, reference, treeStats, codeStats, projectPath }: Record<string, any> = {}) {
  const violations: any[] = []
  const warnings: any[] = []

  // 数据源归一：tree 来自 domDump.tree 或直接传入的 treeStats
  const tree = domDump?.tree || domDump || []
  const flat = Array.isArray(tree) ? flatten(tree) : []
  const total = treeStats?.total ?? flat.length ?? 0
  const absolute = treeStats?.absolute ?? countNodes(tree, (n: any) => n.layout?.position === 'absolute' || n.computed?.position === 'absolute' || n.computed?.position === 'fixed')
  const flex = treeStats?.flex ?? 0

  // 1. absolute/fixed 叶子占比
  if (total > 0) {
    const ratio = absolute / Math.max(1, total)
    // 参考本身若是绝对定位设计（贴纸稿），阈值放宽为参考占比*1.5
    let threshold = 0.15
    if (reference && typeof reference.absoluteRatio === 'number') {
      threshold = Math.max(0.15, reference.absoluteRatio * 1.5)
    } else if (reference?.stats?.absolute != null && reference?.stats?.total != null && reference.stats.total > 0) {
      threshold = Math.max(0.15, (reference.stats.absolute / reference.stats.total) * 1.5)
    }
    if (ratio > threshold) {
      violations.push({ rule: 'absolute-leaf-ratio', value: `${absolute}/${total} = ${(ratio*100).toFixed(1)}%`, threshold: `${(threshold*100).toFixed(0)}%`, severity: 'blocker', reason: '参考为流式布局时，absolute/fixed 占比过高视为硬编码 hack' })
    }
  }

  // 2. 全页 canvas 覆盖：canvas 元素面积 >60% 且 DOM 文本缺失
  {
    let canvasArea = 0, pageArea = 0
    if (domDump?.viewport) pageArea = (domDump.viewport.width||0)*(domDump.viewport.height||0)
    for (const n of flat) {
      const tag = (n.tag || n.type || '').toLowerCase()
      const r = n.rect || n.bbox || null
      const area = r ? (r.w ?? r.width ?? 0) * (r.h ?? r.height ?? 0) : 0
      if (tag === 'canvas') canvasArea += area
    }
    const coverage = pageArea ? canvasArea / pageArea : 0
    const textNodes = flat.filter(n => (n.text && String(n.text).trim()) || n.type === 'TEXT').length
    if (coverage > 0.60 && textNodes < 3) {
      violations.push({ rule: 'canvas-coverage', value: `${(coverage*100).toFixed(1)}% canvas, textNodes=${textNodes}`, threshold: '60% + 文本缺失', severity: 'blocker', reason: '全页 canvas 覆盖且无真实文本，视为假还原' })
    }
  }

  // 3. 背景截图冒充：需传入 codeStats.backgroundHashSim（外部像素 hash 对比）
  if (codeStats?.backgroundHashSim != null && codeStats.backgroundHashSim > 0.95) {
    violations.push({ rule: 'background-screenshot', value: codeStats.backgroundHashSim.toFixed(3), threshold: '0.95', severity: 'blocker', reason: '元素 background-image 与参考截图 hash 相似度过高' })
  }

  // 4. 隐藏真实 DOM
  {
    let hidden=0
    for (const n of flat) {
      const style = n.computed || {}
      const disp = style.display, op = style.opacity, vis = style.visibility
      if (disp === 'none' || op === '0' || op === 0 || vis === 'hidden') hidden++
      // domDump.visible === false 也算隐藏
      if (n.visible === false) hidden = Math.max(hidden, hidden) // 已在上层 count
    }
    // 另：domDump.tree 过滤后可能已剔除 hidden，但 domDump.issues 可保留
    const ratio = total ? hidden / total : 0
    if (ratio > 0.10) {
      violations.push({ rule: 'hidden-dom-ratio', value: `${hidden}/${total} = ${(ratio*100).toFixed(1)}%`, threshold: '10%', severity: 'blocker', reason: '隐藏元素占比过高' })
    }
  }

  // 5. 图片替代文本：关键文本节点为 img 而非 text
  {
    let imgTextReplacements=0
    for (const n of flat) {
      const tag=(n.tag||n.type||'').toLowerCase()
      const text=(n.text||'').trim()
      const role=n.role||''
      // 若节点是 img 且其 alt/文本与参考文本重合，且参考侧对应位置是 text，则视为替换
      if (tag==='img' && text) {
        // 简化：任何带文本的 img 即警告，参考侧有大量文本时升级为 blocker
        imgTextReplacements++
      }
    }
    if (imgTextReplacements > 2) {
      violations.push({ rule: 'image-replaces-text', value: String(imgTextReplacements), threshold: '2', severity: 'blocker', reason: '关键文本用图片替代' })
    }
  }

  // 6. 单 breakpoint 硬编码：codeStats.mediaQueryPixelCover
  if (codeStats?.mediaQueryPixelCover != null && codeStats.mediaQueryPixelCover > 20) {
    warnings.push({ rule: 'single-breakpoint', value: String(codeStats.mediaQueryPixelCover), threshold: '20', severity: 'warning', reason: '单一 media query 内像素覆盖条数过多' })
  }

  // 7. 内联样式 / !important
  {
    const inlineCount = codeStats?.inlineStyleCount ?? countNodes(tree, (n: any) => {
      const s = n.computed || {}
      // 简化：若节点有 style 属性残留（domDump 阶段通常无），此处仅计数 codeStats
      return false
    })
    if (inlineCount > 10) warnings.push({ rule: 'inline-style-count', value: String(inlineCount), threshold: '10', severity: 'warning', reason: '内联样式过多' })
    const importantCount = codeStats?.importantCount ?? 0
    if (importantCount > 10) warnings.push({ rule: 'important-count', value: String(importantCount), threshold: '10', severity: 'warning', reason: '!important 滥用' })
  }

  // 8. 大面积负 margin
  {
    const negCount = codeStats?.negativeMarginCount ?? countNodes(tree, (n: any) => {
      const c = n.computed || {}
      const m = parseFloat(c.marginLeft) || parseFloat(c.marginTop) || parseFloat(c.margin) || 0
      return m < 0
    })
    if (negCount > 3) warnings.push({ rule: 'negative-margin', value: String(negCount), threshold: '3', severity: 'warning', reason: '负 margin 出现过多' })
  }

  const passed = violations.length === 0
  return { violations, warnings, passed, blocked: !passed, summary: passed ? 'clean' : `blocked: ${violations.map(v=>v.rule).join(', ')}` }
}
