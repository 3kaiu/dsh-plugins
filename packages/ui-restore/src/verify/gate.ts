// verify/gate.ts — P0-7 Render+Verify 组合验收(v4 §6: global+region+geometry 三闸合一)
//
// 验收 = 组合 contract:  PASS = globalDiff < threshold(2%)
//                              AND criticalRegions < threshold
//                              AND geometry gates PASS
// 避免「整体 <2% 但核心按钮错位 20px」或「背景渐变微差 3% 但组件全对」两类误判。
// 亦防「C 兜底快照把字体 diff 洗成通过」—— C 的块级缺失时 geometry 会兜底抬违约。

export interface GateThresholds {
  /** 全局像素差异率阈值(默认 0.02 = 2%) */
  globalDiff: number
  /** 标记像素占比阈值(差异区/画布面积, 默认 0.01 = 1%) */
  markedRatio: number
  /** 最大允许差异簇数(默认 0, 零容忍；块级稿可放宽) */
  maxClusters: number
  /** 块级命中率阈值(有块级数据时, 默认 1) */
  blockMatchRate: number
  /** 单簇最大像素占比(超此占比即判 critical, 默认 0.003 = 0.3%画布，对 375x812≈914px ) */
  criticalRegionRatio: number
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  globalDiff: 0.02,
  markedRatio: 0.01,
  maxClusters: 0,
  blockMatchRate: 1,
  criticalRegionRatio: 0.003,
}

export interface GateInput {
  pixel: { diffRatio: number; diffPixels?: number; width?: number; height?: number }
  regions?: { clusterCount: number; markedRatio: number; regions?: Array<{ pixels: number; candidates?: any[] }> } | null
  blocks?: { blockMatchRate: number | null; matchedPairs?: number } | null
  blueprint?: { diffReport?: { verdict: string }; styleDiffReport?: { verdict: string }; truthReport?: { verdict: string }; canvas?: { width: number; height: number } } | null
  /** validateBlueprint 结果(可选)： contractOk 失败即几何为违约 */
  contract?: { ok: boolean; errors?: string[] } | null
  assets?: { summary?: { missing: number; total: number } } | null
  thresholds?: Partial<GateThresholds>
  /**
   * 结构性证据(regions/contract/geometry·style verdict)缺失时的行为。
   * 默认 false = fail-closed：缺证据即整体 FAIL —— 防止「只跑像素闸就宣布通过」的
   * 结构性假阴性出口。仅显式声明 pixel-only 的调用方(明确放弃结构闸)才应传 true。
   * blocks 缺失不在此列：纯图标稿天然无文本块, 缺失属合法输入。
   */
  allowMissingEvidence?: boolean
}

export interface GateDetail {
  global: { pass: boolean; actual: number; threshold: number; detail: string }
  regions: { pass: boolean; actualClusters: number; actualMarkedRatio: number; threshold: GateThresholds; hasCritical: boolean; detail: string }
  geometry: { pass: boolean; contract: string; geometry: string | null; style: string | null; truth: string | null; detail: string }
  assets: { pass: boolean; missing: number; detail: string }
  blocks?: { pass: boolean | null; actual: number | null; threshold: number; detail: string }
}

export interface GateResult {
  pass: boolean
  verdict: 'PASS' | 'FAIL'
  reasons: string[]
  detail: GateDetail
  /** 按严重度排序的待修门禁标签(供 loop 排出优先级) */
  failedGates: string[]
}

/**
 * 组合验收主入口。
 * 全部子闸通过才算 PASS；任一 FAIL 即整体 FAIL。
 */
export function evaluateGate(input: GateInput): GateResult {
  const th: GateThresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds || {}) }
  const allowMissing = input.allowMissingEvidence === true
  const reasons: string[] = []
  const failedGates: string[] = []

  // ---- global ----
  const globalActual = input.pixel?.diffRatio ?? Number.POSITIVE_INFINITY
  const globalPass = Number.isFinite(globalActual) && globalActual < th.globalDiff
  const globalDetail: GateDetail['global'] = {
    pass: globalPass,
    actual: globalActual,
    threshold: th.globalDiff,
    detail: globalPass ? `global ${globalActual} < ${th.globalDiff}` : `global ${globalActual} ≥ ${th.globalDiff}`,
  }
  if (!globalPass) { reasons.push(`全局像素差超阈: ${globalActual} ≥ ${th.globalDiff}`); failedGates.push('global') }

  // ---- regions (criticalRegions) ----
  let regionsPass = true
  let hasCritical = false
  let regionsDetail: GateDetail['regions']
  if (input.regions) {
    const rc = input.regions.clusterCount ?? 0
    const mr = input.regions.markedRatio ?? 0
    // 关键区域 = 单簇像素占比超过 criticalRegionRatio 的簇
    const canvasArea = input.blueprint?.canvas ? (input.blueprint.canvas.width * input.blueprint.canvas.height) : null
    const critical = (input.regions.regions || []).some((r) => {
      if (canvasArea && canvasArea > 0) return (r.pixels / canvasArea) >= th.criticalRegionRatio
      return r.pixels > 800 // 无画布时回退绝对阈值(与 visual-diff major 阈值一致)
    })
    hasCritical = critical
    const clustersOk = rc <= th.maxClusters
    const markedOk = mr < th.markedRatio
    const criticalOk = !critical
    regionsPass = clustersOk && markedOk && criticalOk
    regionsDetail = {
      pass: regionsPass,
      actualClusters: rc,
      actualMarkedRatio: mr,
      threshold: th,
      hasCritical: critical,
      detail: regionsPass ? `regions ok: clusters=${rc}≤${th.maxClusters}, markedRatio=${mr}<${th.markedRatio}, critical=${critical}`
        : `regions fail: clusters ${rc}≤${th.maxClusters}?${clustersOk} markedRatio ${mr}<${th.markedRatio}?${markedOk} critical?${!criticalOk}`,
    }
    if (!regionsPass) { reasons.push(regionsDetail.detail); failedGates.push('regions') }
  } else if (allowMissing) {
    regionsDetail = { pass: true, actualClusters: 0, actualMarkedRatio: 0, threshold: th, hasCritical: false, detail: '无 regions 输入, 调用方已显式声明 pixel-only, 跳过结构闸' }
  } else {
    regionsPass = false
    regionsDetail = { pass: false, actualClusters: 0, actualMarkedRatio: 0, threshold: th, hasCritical: false, detail: '结构性证据缺失: 无 regions 输入(需提供 blueprint 运行 diffRegions); 确要 pixel-only 请显式传 allowMissingEvidence' }
    reasons.push(regionsDetail.detail)
    failedGates.push('regions')
  }

  // ---- geometry (contract + layout diff + style; truth 为软门禁, 仅经 score 惩罚, 不硬性阻断渲染验收)
  // 原因：truth 是 blueprint 推断 vs Yoga 标准求解的保真度，0.5px 级偏差不代表渲染错误；
  // 若 truth 硬性阻断，则 blueprint 自身轻微推断偏差会让所有渲染永远无法 PASS。
  // contract/verdict 缺失默认 fail-closed(见 GateInput.allowMissingEvidence)。
  let geometryPass: boolean
  const contractOk = input.contract ? input.contract.ok === true : allowMissing
  const geometryVerdict = input.blueprint?.diffReport?.verdict ?? null
  const styleVerdict = input.blueprint?.styleDiffReport?.verdict ?? null
  const truthVerdict = input.blueprint?.truthReport?.verdict ?? null
  const geometryOk = geometryVerdict ? String(geometryVerdict).startsWith('PASS') : allowMissing
  const styleOk = styleVerdict ? String(styleVerdict).startsWith('PASS') : allowMissing
  // truth 软性：仅记录，不计入硬门禁；但失败时仍写入 reasons 供诊断（failedGates 记 `truth` 而非 `geometry`）
  const truthOk = !truthVerdict || String(truthVerdict).startsWith('PASS')
  geometryPass = contractOk && geometryOk && styleOk
  const missingLabel = allowMissing ? 'SKIP(pixel-only)' : 'FAIL(缺失)'
  const contractLabel = input.contract
    ? (contractOk ? 'PASS' : `FAIL(${input.contract.errors?.slice(0, 2).join('; ') ?? ''})`)
    : missingLabel
  const geometryDetail: GateDetail['geometry'] = {
    pass: geometryPass,
    contract: contractLabel,
    geometry: geometryVerdict ?? (geometryOk ? null : 'MISSING'),
    style: styleVerdict ?? (styleOk ? null : 'MISSING'),
    truth: truthVerdict,
    detail: geometryPass
      ? `geometry ok: contract ${contractLabel}, geometry ${geometryVerdict ?? 'n/a'}, style ${styleVerdict ?? 'n/a'}, truth ${truthVerdict ?? 'n/a'}`
      : `geometry fail: contract ${contractLabel}, geometry ${geometryVerdict ?? missingLabel}, style ${styleVerdict ?? missingLabel}, truth ${truthVerdict ?? 'n/a'}`,
  }
  if (!geometryPass) { reasons.push(geometryDetail.detail); failedGates.push('geometry') }
  if (!truthOk) {
    // 软门禁：仅作诊断，不阻断 pass，但让上层 score 能看到惩罚
    reasons.push(`truth 软门禁: ${truthVerdict}(经 score 惩罚，不阻断渲染验收)`)
  }

  // ---- assets (missing 禁止近似替代，故计违约) ----
  const missing = input.assets?.summary?.missing ?? 0
  const assetsPass = missing === 0
  const assetsDetail: GateDetail['assets'] = {
    pass: assetsPass,
    missing,
    detail: assetsPass ? 'assets ok: 无缺失' : `assets 缺失 ${missing} 处(仅几何占位, 计违约)`,
  }
  if (!assetsPass) { reasons.push(assetsDetail.detail); failedGates.push('assets') }

  // ---- blocks (仅当提供且非 null 时参与门禁) ----
  let blocksDetail: GateDetail['blocks'] | undefined
  let blocksPass: boolean | null = null
  if (input.blocks && input.blocks.blockMatchRate != null) {
    const bmr = input.blocks.blockMatchRate
    // 矢量字形稿天然 BMR<1：geometry 快照已声明诚实边界，门禁不强制 BMR=1 白名单——
    // 仅当 blueprint 含 TEXT 但无 svgKey 撑文本时才强制(该判断在 caller 侧决定是否传 threshold)
    blocksPass = bmr >= th.blockMatchRate
    blocksDetail = { pass: blocksPass, actual: bmr, threshold: th.blockMatchRate, detail: blocksPass ? `blocks BMR ${bmr}≥${th.blockMatchRate}` : `blocks BMR ${bmr}<${th.blockMatchRate}` }
    if (!blocksPass) { reasons.push(blocksDetail.detail); failedGates.push('blocks') }
  } else {
    blocksDetail = { pass: null, actual: null, threshold: th.blockMatchRate, detail: '无块级数据, 跳过' }
  }

  const pass = globalPass && regionsPass && geometryPass && assetsPass && (blocksPass ?? true)
  return {
    pass,
    verdict: pass ? 'PASS' : 'FAIL',
    reasons,
    detail: { global: globalDetail, regions: regionsDetail, geometry: geometryDetail, assets: assetsDetail, ...(blocksDetail ? { blocks: blocksDetail } as any : {}) },
    failedGates,
  }
}

/**
 * 便捷：blueprint + verifyScreenshots 结果直接求门禁
 */
export function gateFromVerify(opts: {
  pixel: GateInput['pixel']
  regions: GateInput['regions']
  blocks?: GateInput['blocks']
  blueprint: GateInput['blueprint']
  contract?: GateInput['contract']
  assets?: GateInput['assets']
  thresholds?: Partial<GateThresholds>
}): GateResult {
  return evaluateGate(opts)
}
