'use strict'
// metrics — 性能剖析（loop 各阶段耗时与瓶颈）
// 输入：各工具调用的 start/end 时间，输出：聚合报告与优化建议

export function createMetrics() {
  const marks = []
  return {
    mark(name: any, start: any, end = Date.now()) {
      marks.push({ name, start, end, dur: end - start })
    },
    report() {
      const byName: Record<string, any> = {}
      for (const m of marks) {
        if (!byName[m.name]) byName[m.name] = { count: 0, total: 0, max: 0, min: Infinity }
        byName[m.name].count++
        byName[m.name].total += m.dur
        byName[m.name].max = Math.max(byName[m.name].max, m.dur)
        byName[m.name].min = Math.min(byName[m.name].min, m.dur)
      }
      for (const k of Object.keys(byName)) {
        byName[k].avg = Math.round(byName[k].total / byName[k].count)
      }
      const total = marks.reduce((a: any, b: any) => a + b.dur, 0)
      const sorted = Object.entries(byName).sort((a: any, b: any) => b[1].total - a[1].total)
      const bottleneck = sorted[0]?.[0] || null
      return { byName, total, bottleneck, suggestion: bottleneck ? `优化 ${bottleneck}（${byName[bottleneck].total}ms 占 ${Math.round(byName[bottleneck].total/total*100)}%）` : null, marks }
    },
    clear() { marks.length = 0 },
  }
}

export function estimateLoopCost({ sections, viewports, states, hasBrowser }) {
  // 经验：每 section 0.5ms 解析，browser_screenshot 800ms，compare 50ms
  const parse = sections * 0.5
  const screenshots = viewports * states * (hasBrowser ? 800 : 0)
  const compares = viewports * states * 50
  const total = parse + screenshots + compares
  return { parse, screenshots, compares, total, perIteration: total, for30: total * 30 }
}
