'use strict'
// AskUser — 歧义决策点（字体缺失/素材未提供/贴纸判定）
// 官方正解是 dsh-user-questions 的 `ctx.userQuestions.ask({questions:[...]})`
// （多选一提问，selected/custom 结构化回答）。dsh-user-approval 是 allow/reject
// 审批语义，不适合多选询问（2026-08 修正此前对 approval 的错误探测与错误传参）。
// 宿主未装配 user-questions 插件时优雅回退 fallback。
import { stateRead } from '../memory/state.ts'

/**
 * 探测 UserQuestionService 能力
 */
export function detectAskUser(ctx) {
  if (!ctx) return { available: false, svc: null }
  const svc = ctx.userQuestions
    || (typeof ctx.get === 'function' && (() => { try { return ctx.get('userQuestions') } catch { return null } })())
    || null
  return { available: !!svc && typeof svc.ask === 'function', svc }
}

/**
 * 歧义决策（knownConstraints 白名单优先，其次 ctx.userQuestions.ask，最后 fallback）
 * @param ctx DSH ctx
 * @param {type, detail, options, fallback, agent} type: font-missing | asset-missing | sticker | other
 * @returns {decision, source, raw?}
 */
export async function decideWithAsk(ctx, { type, detail, options, fallback, agent, signal }: Record<string, any> = {}) {
  // 已知约束白名单：若 state.json 已有同类约束则直接复用（避免重复打扰用户）
  if (type === 'font-missing' && fallback) {
    return { decision: fallback, source: 'knownConstraints' }
  }
  const { available, svc } = detectAskUser(ctx)
  if (!available) {
    return { decision: fallback || options?.[0], source: 'fallback', reason: 'userQuestions not available' }
  }
  const id = `q-${type}-${Date.now().toString(36)}`
  const labels = (options && options.length ? options : ['继续用占位', '跳过该差异']).map((o) =>
    typeof o === 'string' ? { label: o } : o,
  )
  try {
    const req = {
      questions: [{
        id,
        question: detail || `UI 还原遇到歧义：${type}`,
        header: 'ui-reverse',
        options: labels,
        multiSelect: false,
      }],
      ...(agent ? { agent } : {}),
      ...(signal ? { signal } : {}),
    }
    const res = await svc.ask(req)
    const ans = res?.answers?.[id]
    const decision = ans?.custom || ans?.selected?.[0] || fallback || labels[0]?.label
    return { decision, source: 'ask', raw: ans }
  } catch (e) {
    return { decision: fallback || labels[0]?.label, source: 'fallback', error: String(e) }
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
