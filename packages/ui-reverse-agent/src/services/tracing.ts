'use strict'
// tracing — 可观测性（span/log 的结构化采集，供调试与审计）
// 输出：{traceId, spans:[{name,start,end,dur,attrs}]}

export function createTracer(traceId = `ui-${Date.now().toString(36)}`) {
  const spans = []
  return {
    traceId,
    start(name, attrs: Record<string, any> = {}) {
      const start = Date.now()
      return {
        end(endAttrs: Record<string, any> = {}) {
          const end = Date.now()
          spans.push({ name, start, end, dur: end - start, attrs: { ...attrs, ...endAttrs } })
        }
      }
    },
    report() {
      const total = spans.reduce((a, s) => a + s.dur, 0)
      return { traceId, spans, total, count: spans.length }
    },
    toJson() { return JSON.stringify({ traceId, spans }, null, 2) },
  }
}
