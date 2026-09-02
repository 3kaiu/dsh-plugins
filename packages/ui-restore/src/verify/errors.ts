// verify/errors.ts — P0-5 Error Taxonomy(标准化错误分类 → Repair 策略映射)
//
// 定位: verify/定位产出「哪类错」, Repair 按类选策略 —— 例如
//   gap mismatch → 直接改 gap(确定性, 无需 LLM); position mismatch → 查父布局;
//   asset mismatch → 回 Asset Resolver, 禁止 LLM 乱改 CSS。
// 五大类(v4 §4): LAYOUT / PAINT / TYPOGRAPHY / ASSET / STRUCTURE

export const ERROR_CATEGORIES = ['LAYOUT', 'PAINT', 'TYPOGRAPHY', 'ASSET', 'STRUCTURE']

export const REPAIR_STRATEGY = {
  LAYOUT: {
    /** 数值型偏差优先确定性修复(不走 LLM); 位置类先查父布局再动子项 */
    deterministic: ['gap', 'padding', 'size'],
    llmAllowed: ['position', 'alignment'],
    firstAction: '先核对父容器 contract.layout.strategy, 再改子项; 禁止只改子项坐标掩盖父布局错误',
  },
  PAINT: {
    deterministic: ['color', 'borderRadius'],
    llmAllowed: ['gradient', 'shadow', 'opacity'],
    firstAction: '以蓝图 color/fill/stroke 为准; token 存在时优先引用 token',
  },
  TYPOGRAPHY: {
    deterministic: ['fontSize', 'lineHeight', 'maxLines'],
    llmAllowed: ['wrap', 'letterSpacing'],
    firstAction: '字体缺失(webFontNeeded)时先解决字体环境, 不得判为 CSS bug',
  },
  ASSET: {
    deterministic: [],
    llmAllowed: [],
    firstAction: '回 Asset Resolver: missing=补导出/回填; crop/scale=修 background 映射; 禁止 LLM 用近似图形/CSS 手绘替代',
  },
  STRUCTURE: {
    deterministic: [],
    llmAllowed: ['missing', 'extra', 'wrong-hierarchy'],
    firstAction: '对照 checklist 合同: 缺失=补实现, 多余=删; 层级按 floatings>tree、数组序自下而上',
  },
}

/**
 * 生成一条分类错误。
 * @param {object} e {category, kind, nodeId, detail, expected?, actual?, confidence?}
 */
export function classifyError(e: any) {
  if (!ERROR_CATEGORIES.includes(e.category)) throw new Error(`未知错误类: ${e.category}(允许: ${ERROR_CATEGORIES.join('/')})`)
  return {
    category: e.category,
    kind: e.kind,
    nodeId: e.nodeId ?? null,
    detail: e.detail ?? '',
    expected: e.expected ?? null,
    actual: e.actual ?? null,
    confidence: e.confidence ?? 1,
    repair: REPAIR_STRATEGY[e.category],
  }
}

/**
 * 差异区域 + 蓝图节点候选 → 分类错误列表(verify 与 Repair 之间的标准格式)。
 * 判定规则(确定性优先):
 *   区域含 TEXT 节点候选 → 先记 TYPOGRAPHY-pending(由块级/几何证据升级)
 *   区域节点无 fill/svg 数据 → ASSET
 *   纯几何容器 → LAYOUT
 * severity 沿用 diffToCorrections 的 major/minor/noise。
 */
export function classifyRegions(regions: any, bp: any) {
  const out = []
  for (const r of regions?.regions || []) {
    const severity = r.markedSeverity || 'minor'
    for (const c of r.candidates || []) {
      const n = findNode(bp, c.id)
      if (!n) continue
      if (n.svgKey && !hasSvgSource(n)) {
        out.push(classifyError({ category: 'ASSET', kind: 'svg', nodeId: n.id, detail: `svgKey ${n.svgKey} 无导出源, 区域像素差可能源于占位`, expected: '真实矢量', actual: '几何占位', confidence: 0.8 }))
      } else if (n.fill?.type === 'image') {
        out.push(classifyError({ category: 'ASSET', kind: 'image', nodeId: n.id, detail: '位图资产差异(缺失/裁切/缩放)', confidence: 0.7 }))
      } else if (typeof n.text === 'string' && n.text) {
        out.push(classifyError({ category: 'TYPOGRAPHY', kind: 'wrap', nodeId: n.id, detail: `文本区域像素差: "${String(n.text).slice(0, 12)}"`, confidence: 0.5 }))
      } else if ((n.children || []).length === 0) {
        out.push(classifyError({ category: 'PAINT', kind: 'color', nodeId: n.id, detail: '叶子区域像素差(颜色/描边/阴影待下钻核对)', confidence: 0.5 }))
      } else {
        out.push(classifyError({ category: 'LAYOUT', kind: 'position', nodeId: n.id, detail: '容器区域像素差(位置/尺寸待下钻核对)', confidence: 0.5 }))
      }
    }
    if (!r.candidates?.length) {
      out.push(classifyError({ category: 'STRUCTURE', kind: 'missing', nodeId: null, detail: `区域(${r.x},${r.y} ${r.width}x${r.height})无蓝图节点命中 — 疑似缺失或越界内容`, confidence: 0.6 }))
    }
    void severity
  }
  return out
}

function hasSvgSource(n: any) { return Boolean(n.svgResolved || n.svg) }
function findNode(bp: any, id: any) {
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return null
    if (n.id === id) return n
    for (const c of n.children || []) { const hit = walk(c); if (hit) return hit }
    return null
  }
  for (const r of [...(bp?.tree || []), ...(bp?.floatings || [])]) { const hit = walk(r); if (hit) return hit }
  return null
}
