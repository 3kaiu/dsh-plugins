'use strict'
// streaming — 实时流式（progress 的增量推送与 live preview）
// 输出：{event, data, at} 的流，供 UI 增量渲染（与 DSH 的 tool/result 流水互补）

export function createStream() {
  const events = []
  return {
    push(event: any, data: any) {
      events.push({ event, data, at: new Date().toISOString() })
    },
    flush() {
      const out = [...events]
      events.length = 0
      return out
    },
    snapshot() { return [...events] },
  }
}

export function livePreviewHtml({ blueprint, score, iteration }) {
  // 极简增量 HTML（每轮后生成，供 live preview iframe）
  const title = `Iteration ${iteration} — S ${score?.total ?? '?'}/0.96`
  const regions = (blueprint?.regions || []).map((r: any) => `<div>${r.name} (${r.priority})</div>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${regions}</body></html>`
}
