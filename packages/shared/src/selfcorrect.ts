'use strict'
// 自纠错：regression 定位与回滚指令 + 停滞检测（§7）
// 输入：state.json 形态的 history / scores

export function detectRegression({ scores, history, current, previous } = {}) {
  // scores: { history: [{iteration,total, ...layers}], current:{total}, previous:{total} }
  const hist = history || scores?.history || []
  const cur = current || scores?.current
  const prev = previous || scores?.previous
  const delta = cur && prev && typeof cur.total === 'number' && typeof prev.total === 'number' ? cur.total - prev.total : null

  let triggered = false
  let reason = null

  if (typeof delta === 'number' && delta <= -0.02) {
    triggered = true
    reason = `ΔS ${delta.toFixed(3)} ≤ -0.02`
  }
  // 任意层分数下降 >0.05
  if (!triggered && cur && prev) {
    for (const k of ['struct','geom','pixel','type','color']) {
      const a = prev[k], b = cur[k]
      if (typeof a === 'number' && typeof b === 'number' && (a - b) > 0.05) {
        triggered = true
        reason = `${k} ${a} → ${b} drop >0.05`
        break
      }
    }
  }
  // 新增 P0 差异：由上层 compare 传入（此处仅检测标记）
  if (!triggered && cur?.hasNewP0) {
    triggered = true
    reason = '新增 P0 差异'
  }

  return { triggered, delta, reason }
}

export function stagnationCheck(history, opts = {}) {
  const window = opts.window ?? 3
  const threshold = opts.threshold ?? 0.005
  if (!Array.isArray(history) || history.length < window) return { stalled: false }
  const recent = history.slice(-window)
  const deltas = []
  for (let i=1;i<recent.length;i++) {
    const a = recent[i-1].total, b = recent[i].total
    if (typeof a === 'number' && typeof b === 'number') deltas.push(b - a)
  }
  const allSmall = deltas.length === window-1 && deltas.every(d => d < threshold)
  return { stalled: allSmall, deltas, reason: allSmall ? `连续 ${window} 轮 ΔS < ${threshold}` : null }
}

export function rollbackPlan({ history, iteration, rollbackPoints } = {}) {
  // history: 最近变更记录；rollbackPoints: [{iteration, git, note}]
  // 策略：若本轮单假设，直接回滚本轮文件；否则二分到最近干净点
  if (!rollbackPoints || rollbackPoints.length === 0) {
    return { action: 'manual', reason: '无回滚点，需手动 git checkout' }
  }
  const sorted = [...rollbackPoints].sort((a,b)=>b.iteration - a.iteration)
  const nearestClean = sorted[0]
  return { action: 'rollback', target: nearestClean, reason: `回滚到最近干净点 iteration ${nearestClean.iteration} (${nearestClean.git||'stash'})` }
}

export function markRejected(differences, rejectedPath) {
  return differences.map(d => d.path === rejectedPath ? { ...d, rejected: true, note: '已回滚，避免重犯' } : d)
}
