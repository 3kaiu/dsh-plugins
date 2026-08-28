'use strict'
// AskUser — 歧义决策点（字体缺失/素材未提供/贴纸判定）
// 优先 ctx.approval / ctx.askUser（dsh-user-approval），否则回退到 knownConstraints 白名单 + 占位

/**
 * 探测 Ask-User 能力
 */
export function detectAskUser(ctx) {
  if (!ctx) return { available: false, svc: null }
  const svc = ctx.approval || ctx.askUser || (ctx.get && (() => { try { return ctx.get('approval') } catch { return null } })()) || null
  const alt = !svc && ctx.get ? (() => { try { return ctx.get('dsh-user-approval') } catch { return null } })() : null
  const s = svc || alt
  return { available: !!s && (typeof s.ask === 'function' || typeof s.request === 'function'), svc: s }
}

/**
 * 歧义决策（白名单优先，其次询问）
 * @param ctx DSH ctx
 * @param {type, detail, options, fallback} type: font-missing | asset-missing | sticker | other
 * @returns {decision, source}
 */
export async function decideWithAsk(ctx, { type, detail, options, fallback }) {
  // 已知约束白名单：若 state.json 已有同类约束则直接复用
  if (type === 'font-missing' && fallback) {
    return { decision: fallback, source: 'knownConstraints' }
  }
  const { available, svc } = detectAskUser(ctx)
  if (!available) {
    // 无询问能力：记录约束并用 fallback
    return { decision: fallback || options?.[0], source: 'fallback', reason: 'ask not available' }
  }
  try {
    const askFn = svc.ask || svc.request
    const res = await askFn.call(svc, {
      question: detail || `UI 还原遇到歧义：${type}`,
      options: options || ['继续用占位', '跳过该差异'],
      kind: type,
    })
    const decision = res?.answer || res?.decision || res?.selected || options?.[0]
    return { decision, source: 'ask', raw: res }
  } catch (e) {
    return { decision: fallback || options?.[0], source: 'fallback', error: String(e) }
  }
}

/**
 * ConversationNode 热图可视化辅助
 * 若宿主提供 conversation / nodes / typert，则构造 diff-heatmap 节点；否则回退到 tool_result 的 PNG 路径
 */
export function buildHeatmapNode({ diffPath, regionScores, score }) {
  // 结构化节点（供未来的 dsh-client-ui-tool / typert 消费）
  return {
    kind: 'ui-reverse:diff-heatmap',
    version: 1,
    diffPath,
    regionScores,
    score,
    // 宿主若支持 ConversationNode keyed 渲染，可按此结构直出
    present: {
      type: 'card',
      title: `Visual Diff — S ${score?.total ?? '?'}（${score?.blocked ? 'blocked' : 'ok'}）`,
      image: diffPath,
      regions: regionScores || [],
    },
  }
}
