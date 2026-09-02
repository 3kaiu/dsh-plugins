// verify/score.ts — P0-8 Convergence Score(单调收敛, 取代固定 5 次)
//
// v4 §6: score = globalDiff + regionDiff + geometryPenalty + changedAreaPenalty + contractViolationPenalty
// 修复 A(小面积改、几何干净) > 修复 B(像素略好但几何破坏/大面积改) —— 人为权重由该式显式承载，
// 而 pipeline 的字典序质量键仅作轻量快检，本评分作收敛仲裁(vs 质量键互补)。
//
// 停止条件：单调收敛 —— 每轮 score 不劣化即通过 best/regress；
// 参考预算 P50≤3 / P90≤5 / P95≤8，验收以「能单调收敛」优先于「5 次必收敛」。

export interface ScoreInput {
  pixel: { diffRatio: number; diffPixels?: number }
  regions?: { clusterCount: number; markedRatio: number } | null
  blueprint?: {
    diffReport?: { verdict: string; maxDelta?: number }
    styleDiffReport?: { verdict: string }
    truthReport?: { verdict: string; maxDelta?: number }
    canvas?: { width: number; height: number }
  } | null
  contract?: { ok: boolean; errors?: string[] } | null
  assets?: { summary?: { missing: number; total: number } } | null
  blocks?: { blockMatchRate: number | null } | null
  /** 本轮改动规模(用于 changedAreaPenalty) */
  changed?: { files?: number; changedLines?: number; totalLines?: number } | null
}

export interface ScoreWeights {
  global: number
  region: number
  geometry: number
  changedArea: number
  contract: number
  blocks: number
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  global: 1.0,
  region: 1.0,
  geometry: 0.8,
  changedArea: 0.3,
  contract: 0.5,
  blocks: 0.4,
}

export interface ScoreResult {
  /** 综合分(越小越好) */
  score: number
  /** 各分量(已加权前数值, 供诊断) */
  components: {
    globalDiff: number
    regionDiff: number
    geometryPenalty: number
    changedAreaPenalty: number
    contractViolationPenalty: number
    blocksPenalty: number
  }
  /** 加权后分量(求和=score) */
  weighted: Record<keyof ScoreWeights, number>
  verdict: string
}

export function computeScore(input: ScoreInput, weights: Partial<ScoreWeights> = {}): ScoreResult {
  const w: ScoreWeights = { ...DEFAULT_WEIGHTS, ...weights }

  const globalDiff = Number.isFinite(input.pixel?.diffRatio) ? input.pixel.diffRatio : 1
  const regionDiff = input.regions ? (input.regions.markedRatio ?? 0) + Math.min(0.2, (input.regions.clusterCount ?? 0) * 0.02) : (globalDiff * 0.5)

  // geometry: diffReport / truthReport / styleDiffReport 任一 FAIL 即惩罚
  let geometryPenalty = 0
  const geoVerdict = input.blueprint?.diffReport?.verdict
  if (geoVerdict && !String(geoVerdict).startsWith('PASS')) geometryPenalty += 1
  const truthVerdict = input.blueprint?.truthReport?.verdict
  if (truthVerdict && !String(truthVerdict).startsWith('PASS')) geometryPenalty += 0.6
  const styleVerdict = input.blueprint?.styleDiffReport?.verdict
  if (styleVerdict && !String(styleVerdict).startsWith('PASS')) geometryPenalty += 0.4
  // 未惩罚封顶 2

  const missing = input.assets?.summary?.missing ?? 0
  const contractErrors = input.contract && !input.contract.ok ? (input.contract.errors?.length ?? 1) : 0
  const contractViolationPenalty = missing * 0.25 + contractErrors * 0.15

  // changedArea: 行变化比(改动行/总行, 缺失时 0)
  let changedAreaPenalty = 0
  if (input.changed && (input.changed.changedLines != null)) {
    const total = Math.max(1, input.changed.totalLines ?? 400)
    changedAreaPenalty = Math.min(1, (input.changed.changedLines / total))
  }

  let blocksPenalty = 0
  if (input.blocks && input.blocks.blockMatchRate != null) {
    // BMR=1 →0, BMR=0→1
    blocksPenalty = Math.max(0, 1 - input.blocks.blockMatchRate)
  }

  const weighted = {
    global: globalDiff * w.global,
    region: regionDiff * w.region,
    geometry: geometryPenalty * w.geometry,
    changedArea: changedAreaPenalty * w.changedArea,
    contract: contractViolationPenalty * w.contract,
    blocks: blocksPenalty * w.blocks,
  }
  const score = Object.values(weighted).reduce((s: any, v: any) => s + v, 0)
  const verdict = geometryPenalty > 0 || contractViolationPenalty > 0 ? `SCORE_${score.toFixed(4)}_WITH_VIOLATION` : `SCORE_${score.toFixed(4)}`

  return {
    score: Math.round(score * 10000) / 10000,
    components: { globalDiff, regionDiff, geometryPenalty, changedAreaPenalty, contractViolationPenalty, blocksPenalty },
    weighted: weighted as any,
    verdict,
  }
}

/** 是否更优(分数更小即更优；分数相等时以几何干净优先) */
export function isBetter(a: ScoreResult, b: ScoreResult): boolean {
  if (a.score !== b.score) return a.score < b.score
  if (a.components.geometryPenalty !== b.components.geometryPenalty) return a.components.geometryPenalty < b.components.geometryPenalty
  if (a.components.contractViolationPenalty !== b.components.contractViolationPenalty) return a.components.contractViolationPenalty < b.components.contractViolationPenalty
  return a.components.globalDiff < b.components.globalDiff
}

export interface ConvergeHistoryEntry {
  iteration: number
  score: ScoreResult
  gatePass: boolean
}

export interface ConvergeState {
  best: ConvergeHistoryEntry | null
  history: ConvergeHistoryEntry[]
  regressed: boolean
  shouldStop: boolean
  reason: string
  /** 机器可读停机类别 —— 消费方(loop)以此分支, 禁止对 reason 中文案做子串匹配 */
  stopKind?: 'gate-pass' | 'max-iterations' | 'score-converged' | 'stalled'
}

/**
 * 更新收敛状态（单调收敛仲裁）
 * @param cur 本轮 score+gate
 * @param state 已有状态
 * @param opts {maxIterations, patience, scoreThreshold}
 */
export function updateConvergence(
  cur: { iteration: number; score: ScoreResult; gatePass: boolean },
  state: ConvergeState | null,
  opts: { maxIterations?: number; patience?: number; scoreThreshold?: number } = {},
): ConvergeState {
  const maxIterations = opts.maxIterations ?? 8
  const patience = opts.patience ?? 2
  const scoreThreshold = opts.scoreThreshold ?? 0.04
  const hist: ConvergeHistoryEntry[] = state ? [...state.history] : []
  const entry: ConvergeHistoryEntry = { iteration: cur.iteration, score: cur.score, gatePass: cur.gatePass }
  hist.push(entry)

  const best = state?.best ?? null
  let newBest = best
  let regressed = false
  if (!best || isBetter(cur.score, best.score)) newBest = entry
  else if (cur.score.score > best.score.score + 1e-6) regressed = true

  let shouldStop = false
  let reason = ''
  let stopKind: ConvergeState['stopKind'] = undefined

  if (cur.gatePass) {
    shouldStop = true
    reason = `门禁已通过(iter#${cur.iteration}, score=${cur.score.score})`
    stopKind = 'gate-pass'
  } else if (cur.iteration >= maxIterations) {
    shouldStop = true
    reason = `达到最大迭代 ${maxIterations}`
    stopKind = 'max-iterations'
  } else if (cur.score.score <= scoreThreshold && cur.score.components.geometryPenalty === 0) {
    shouldStop = true
    reason = `分数已收敛到阈值 ${scoreThreshold}(score=${cur.score.score})`
    stopKind = 'score-converged'
  } else if (hist.length >= patience + 1) {
    // 连续 patience 轮未刷新 best → 停
    const recentBests = hist.slice(-patience).every((h: any) => h.score.score >= (newBest?.score.score ?? Infinity))
    if (recentBests && newBest && newBest.iteration <= cur.iteration - patience) {
      shouldStop = true
      reason = `连续 ${patience} 轮未提升(best iter#${newBest.iteration})`
      stopKind = 'stalled'
    }
  }

  return { best: newBest, history: hist, regressed, shouldStop, reason, stopKind }
}

/** 兼容 pipeline 的字典序质量键：score 同时产出 lex 键供旧链路比对 */
export function scoreToQualityKey(score: ScoreResult, regions?: { clusterCount: number; markedRatio: number }, pixel?: { diffRatio: number }) {
  return [regions?.clusterCount ?? 0, regions?.markedRatio ?? pixel?.diffRatio ?? 1, pixel?.diffRatio ?? 1] as [number, number, number]
}
