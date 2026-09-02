'use strict'
// LspMap — Phase2 仓库映射：蓝图节点 → 现有组件/CSS/资产
// 优先 LSP（精准 definition/references），降级 grep/glob（容错），纯函数 + ctx 探测双形态

/**
 * 探测宿主是否提供 LSP（dsh-lsp 或兼容的 ctx.lsp / ctx.get('lsp')）
 * 返回 { available, lsp }，available=false 时调用方走 grep 降级
 */
export function detectLsp(ctx) {
  if (!ctx) return { available: false, lsp: null }
  const lsp = ctx.lsp || (ctx.get && (() => { try { return ctx.get('lsp') } catch { return null } })()) || null
  // 兼容：部分部署把 LSP 以 dsh-lsp 键暴露
  const alt = !lsp && ctx.get ? (() => { try { return ctx.get('dsh-lsp') } catch { return null } })() : null
  const svc = lsp || alt
  if (!svc) return { available: false, lsp: null }
  // 最小可用性检查：需有 findDefinitions 或 goToDefinition 之一
  const hasMethod = typeof svc.goToDefinition === 'function' || typeof svc.findReferences === 'function' || typeof svc.search === 'function'
  return { available: hasMethod, lsp: hasMethod ? svc : null }
}

/**
 * 蓝图节点映射单条（纯逻辑，不依赖 ctx，直接可测）
 * @param blueprintNode {name, role, type, selector} 蓝图节点摘要
 * @param candidates [{file, snippet, score}] 来自 grep/glob 或 LSP 的候选
 * @returns {component, css, asset, confidence, reason}
 */
export function mapSingleNode(blueprintNode, candidates = []) {
  if (!candidates.length) {
    return { blueprintNode, component: null, css: null, asset: null, confidence: 0, reason: 'unmapped — 无候选', status: 'unmapped' }
  }
  // 按 score 降序
  const sorted = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const top = sorted[0]
  // 置信度：score 归一（grep 的 score 可能是 bm25，LSP 的 score 可能是 1.0 精准）
  const confidence = Math.min(1, (top.score ?? 0.5))
  // 规则：若 top 来自 LSP definition 且 name 完全匹配，confidence 1.0
  if (top.source === 'lsp' && top.matchedName === blueprintNode.name) {
    return { blueprintNode, component: top.file, css: top.cssFile || null, asset: top.asset || null, confidence: 1, reason: 'lsp exact', status: 'reuse' }
  }
  // 若 file 含 component 且 snippet 含 blueprintNode.name，视为复用
  if (top.file && top.file.match(/\.(tsx|jsx|vue)$/)) {
    return { blueprintNode, component: top.file, css: top.cssFile || null, asset: null, confidence, reason: `grep hit ${top.matchedName || ''}`, status: confidence > 0.7 ? 'reuse' : 'maybe' }
  }
  // 否则建议新建
  return { blueprintNode, component: null, css: null, asset: null, confidence, reason: 'candidates not component', status: 'create' }
}

/**
 * 批量映射（Phase2 产出 mapping.md 的结构化前驱）
 * @param blueprint {tree, assets} 蓝图
 * @param candidatesByNode Map<blueprintNodeId, candidates[]>
 * @returns {mappings, unmapped, summary}
 */
export function mapBlueprint(blueprint, candidatesByNode = new Map()) {
  const tree = blueprint.tree || blueprint
  const nodes = flattenBlueprint(tree)
  const mappings = []
  let reused = 0, created = 0
  for (const n of nodes) {
    const key = n.id || n.name || JSON.stringify(n).slice(0, 80)
    const cands = candidatesByNode.get(key) || candidatesByNode.get(n.name) || []
    const m = mapSingleNode({ name: n.name, role: n.role, type: n.type, selector: n.selector }, cands)
    mappings.push(m)
    if (m.status === 'reuse') reused++
    else if (m.status === 'create' || m.status === 'unmapped') created++
  }
  return {
    mappings,
    unmapped: mappings.filter(m => m.status === 'unmapped'),
    summary: { total: nodes.length, reused, created, unmapped: mappings.filter(m => m.status === 'unmapped').length },
  }
}

function flattenBlueprint(tree) {
  const out = []
  const walk = (nodes: any) => {
    for (const n of (Array.isArray(nodes) ? nodes : [nodes])) {
      out.push(n)
      if (n.children?.length) walk(n.children)
    }
  }
  walk(tree)
  return out
}

/**
 * LSP 感知的候选生成（供 tool 层调用，ctx 可选）
 * 1) 若 ctx.lsp 可用：调 goToDefinition/findReferences 精准
 * 2) 否则：返回空，调用方走宿主的 glob/grep 工具（不在本模块内做 IO，避免与现有宿主 read/glob 重叠）
 */
export async function collectCandidatesWithLsp(ctx: any, blueprintNode: any) {
  const { available, lsp } = detectLsp(ctx)
  if (!available) return { source: 'none', candidates: [], reason: 'lsp not available, fallback to grep' }
  try {
    // 约定：lsp 暴露的 search 接口接收 {query, kind}
    if (typeof lsp.search === 'function') {
      const res = await lsp.search({ query: blueprintNode.name, kind: 'component' })
      const cands = (Array.isArray(res) ? res : res?.results || []).map(r => ({
        file: r.file || r.uri,
        snippet: r.snippet || '',
        score: r.score ?? 0.9,
        source: 'lsp',
        matchedName: r.name || blueprintNode.name,
      }))
      return { source: 'lsp', candidates: cands, reason: 'lsp.search' }
    }
    if (typeof lsp.goToDefinition === 'function') {
      const res = await lsp.goToDefinition({ symbol: blueprintNode.name })
      const cands = (Array.isArray(res) ? res : []).map(r => ({ file: r.file, score: 1, source: 'lsp', matchedName: blueprintNode.name }))
      return { source: 'lsp', candidates: cands, reason: 'lsp.goToDefinition' }
    }
  } catch (e) {
    return { source: 'lsp-error', candidates: [], reason: String(e) }
  }
  return { source: 'lsp', candidates: [], reason: 'no lsp method matched' }
}
