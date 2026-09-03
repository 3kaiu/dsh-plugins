'use strict'
// recovery — 容错恢复（devServer/browser/网络/文件的重试与降级）
// 输入：错误类型与上下文，输出：{retry, delay, fallback, reason}
// 与 selfcorrect（ΔS 回滚）互补：recovery 处理基础设施失败，selfcorrect 处理视觉回归

export const RECOVERY_POLICY = {
  devServer: { retries: 2, delayMs: 2000, fallback: 'raw-fallback' },
  browser: { retries: 1, delayMs: 1000, fallback: 'restart-context' },
  network: { retries: 3, delayMs: 800, fallback: 'cached' },
  file: { retries: 1, delayMs: 0, fallback: 'skip' },
}

export function classifyError(error: any) {
  const msg = String(error?.message || error || '').toLowerCase()
  if (msg.includes('devserver') || msg.includes('econnrefused') || msg.includes('port')) return 'devServer'
  if (msg.includes('browser') || msg.includes('chromium') || msg.includes('playwright') || msg.includes('context')) return 'browser'
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('timeout') || msg.includes('econn')) return 'network'
  if (msg.includes('enoent') || msg.includes('eacces') || msg.includes('file')) return 'file'
  return 'unknown'
}

export function recoveryPlan(error: any, attempt = 0) {
  const kind = classifyError(error)
  const policy = (RECOVERY_POLICY as any)[kind]
  if (!policy) return { kind, retry: false, reason: 'unknown error, no policy' }
  const shouldRetry = attempt < policy.retries
  return {
    kind,
    retry: shouldRetry,
    delayMs: shouldRetry ? policy.delayMs : 0,
    fallback: !shouldRetry ? policy.fallback : null,
    attempt: attempt + 1,
    maxRetries: policy.retries,
    reason: shouldRetry ? `${kind} retry ${attempt + 1}/${policy.retries}` : `${kind} fallback ${policy.fallback}`,
  }
}

export async function withRetry(fn: any, { kind = 'network', maxRetries, delayMs }: Record<string, any> = {}) {
  const policy = (RECOVERY_POLICY as any)[kind] || { retries: 2, delayMs: 800 }
  const retries = maxRetries ?? policy.retries
  const delay = delayMs ?? policy.delayMs
  let lastError
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      const plan = recoveryPlan(e, i)
      if (!plan.retry) throw e
      if (plan.delayMs) await new Promise(r => setTimeout(r, plan.delayMs))
    }
  }
  throw lastError
}
