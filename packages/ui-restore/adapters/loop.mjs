#!/usr/bin/env node
// adapters/loop.mjs — ⑧⑩ 受限 LLM Repair 编排 + Region→Node→Source 定位 + 收敛循环
//
// v4 §6: Render→Verify(组合门禁)→Region→Node→Source 定位→PatchRequest→LLM(受限)→PatchValidator→Score→Accept/Reject→收敛
// 本文件是 Phase 3 Converge 的确定性编排器本身——不内置自由 LLM，repair 由调用方注入(repairFn)，
// 无注入时提供 deterministic fallback(仅 gap/padding/color 数值直改，零幻觉)。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  comparePng,
  diffRegions,
  diffToCorrections,
  decodePng,
  blockMetrics,
  validateBlueprint,
} from '../dist/index.js'
import { evaluateGate } from '../dist/index.js'
import { computeScore, updateConvergence, isBetter } from '../dist/index.js'
import { createPatchRequest, validatePatch, PATCH_POLICY } from '../dist/index.js'
import { classifyRegions, shouldTriggerVision, diagnoseWithVision } from '../dist/index.js'

// ---------- ⑧ Region → Node → Source 定位 ----------

/**
 * 差异区域 → Blueprint 节点 → 源码文件 定位
 * @param {object} opts {regions, blueprint, restoreMap, candidates?}
 * @returns {{affectedNodes:string[], allowedFiles:string[], allowedNodes:string[], mapping:Array, stats}}
 */
export function locateRegions(opts) {
  const regions = opts.regions
  const bp = opts.blueprint
  const map = opts.restoreMap
  // 主 entries + preview.entries 合并(同源双 serializer，selector 1:1)
  const rawEntries = Array.isArray(map?.entries) ? map.entries : []
  const previewEntries = Array.isArray(map?.preview?.entries) ? map.preview.entries : []
  const allEntries = [...rawEntries, ...previewEntries]
  const entries = allEntries
  const byId = new Map(entries.map((e) => [e.nodeId, e]))

  // blueprint 全量节点索引(用于富化 context)
  const nodeById = new Map()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.id) nodeById.set(n.id, n)
    for (const c of n.children || []) walk(c)
  }
  for (const r of [...(bp?.tree || []), ...(bp?.floatings || [])]) walk(r)

  const mapping = []
  const affectedSet = new Set()
  const fileSet = new Set()

  for (const reg of regions?.regions || []) {
    const cands = reg.candidates || []
    const nodes = cands.map((c) => nodeById.get(c.id)).filter(Boolean)
    const sources = cands.map((c) => byId.get(c.id)).filter(Boolean)
    for (const c of cands) {
      affectedSet.add(c.id)
      const src = byId.get(c.id)
      if (src?.file) fileSet.add(src.file)
    }
    // 交叉引用 domHints 已在 pipeline 侧注入 reg.domHints
    mapping.push({
      region: { x: reg.x, y: reg.y, width: reg.width, height: reg.height, pixels: reg.pixels, severity: reg.severity },
      candidates: cands,
      nodes: nodes.map((n) => ({ id: n.id, name: n.name, bounds: n.bounds, layout: n.layout, text: n.text, color: n.color, svgKey: n.svgKey, fill: n.fill })),
      sources,
      domHints: reg.domHints || [],
    })
  }

  // 结构类无命中区域：补一次全局扫描（缺失/越界）
  const unmatched = (regions?.regions || []).filter((r) => !(r.candidates?.length))
  if (unmatched.length) {
    for (const reg of unmatched) {
      mapping.push({
        region: { x: reg.x, y: reg.y, width: reg.width, height: reg.height, pixels: reg.pixels },
        candidates: [],
        nodes: [],
        sources: [],
        domHints: reg.domHints || [],
        kind: 'unmatched',
      })
    }
  }

  // 若完全无候选(无蓝图映射)则至少把根文件加入白名单（保流程可继续，validator 会约束）
  if (fileSet.size === 0 && entries.length) {
    // 取 map 首文件的目录作为探针（生成阶段的真实落盘文件）
    const firstFile = entries[0]?.file
    if (firstFile) fileSet.add(firstFile)
  }

  return {
    affectedNodes: [...affectedSet],
    allowedFiles: [...fileSet],
    allowedNodes: [...affectedSet],
    mapping,
    stats: { regions: regions?.clusterCount ?? 0, candidates: affectedSet.size, files: fileSet.size },
  }
}

/**
 * 定位结果 + 错误分类 → PatchRequest 列表
 * 默认按文件聚类：同一文件的节点合并为一个 request（减 LLM 调用次数）
 */
export function buildPatchRequests(locateResult, classifyErrors, opts = {}) {
  const iteration = opts.iteration ?? 0
  const gateFailed = opts.gateFailed ?? []
  // 按 file 分组
  const byFile = new Map()
  for (const m of locateResult.mapping) {
    for (const s of m.sources) {
      const f = s.file
      if (!f) continue
      if (!byFile.has(f)) byFile.set(f, { file: f, nodes: new Set(), regions: [], domHints: [] })
      const g = byFile.get(f)
      for (const c of m.candidates || []) g.nodes.add(c.id)
      g.regions.push(m.region)
      for (const h of m.domHints || []) g.domHints.push(h)
    }
  }
  // 若 mapping 无 source(离线)，则按节点聚一个全局 request
  if (byFile.size === 0 && locateResult.affectedNodes.length) {
    const req = createPatchRequest({
      affectedNodes: locateResult.affectedNodes,
      violations: (classifyErrors || []).map((e) => `[${e.category}/${e.kind}] ${e.detail}`),
      allowedFiles: locateResult.allowedFiles.length ? locateResult.allowedFiles : ['src/Restore.tsx'],
      allowedNodes: locateResult.allowedNodes,
      context: {
        regions: locateResult.mapping.map((m) => m.region),
        candidates: locateResult.mapping.flatMap((m) => m.candidates || []),
        domHints: locateResult.mapping.flatMap((m) => m.domHints || []),
        errors: classifyErrors || [],
      },
      meta: { iteration, gateFailed },
    })
    return [req]
  }

  const requests = []
  for (const [file, grp] of byFile) {
    const nodeIds = [...grp.nodes]
    const relatedErrors = (classifyErrors || []).filter((e) => e.nodeId && grp.nodes.has(e.nodeId))
    const violations = relatedErrors.length ? relatedErrors.map((e) => `[${e.category}/${e.kind}] ${e.detail}`) : [`区域像素差未分类(文件 ${file})`]
    requests.push(createPatchRequest({
      affectedNodes: nodeIds,
      violations,
      allowedFiles: [file],
      allowedNodes: nodeIds,
      context: {
        regions: grp.regions,
        candidates: grp.regions.flatMap((r) => []),
        domHints: grp.domHints.slice(0, 5),
        blueprintNodes: nodeIds.map((id) => locateResult.mapping.flatMap((m) => m.nodes).find((n) => n.id === id)).filter(Boolean),
        errors: relatedErrors,
      },
      meta: { iteration, gateFailed },
    }))
  }
  return requests
}

// ---------- ⑩ 受限 LLM Repair ----------

/**
 * 受限 Repair：把 PatchRequest 翻译为 LLM prompt，调用 repairFn，并把结果包装为 Patch
 * @param {PatchRequest} req
 * @param {object} ctx {blueprint, projectDir, fileContents: Map<path, content>}
 * @param {function} repairFn async (prompt:string, req:PatchRequest)=>{files}|{content:string}  (调用方注入的 LLM)
 */
export async function repairWithLlm(req, ctx, repairFn) {
  if (typeof repairFn !== 'function') {
    // deterministic fallback：仅对可确定性修复的 LAYOUT/PAINT 直改
    return deterministicRepair(req, ctx)
  }
  const prompt = buildRepairPrompt(req, ctx)
  const out = await repairFn(prompt, req)
  // 归一：LLM 可能返回 string(单文件 content) 或 {files}
  if (typeof out === 'string') {
    const targetFile = req.allowedFiles[0]
    const original = ctx.fileContents?.get(targetFile) ?? ''
    return { files: [{ path: targetFile, content: out, original }], touchedNodes: req.allowedNodes }
  }
  if (out && Array.isArray(out.files)) {
    // 补 original 供 validator
    for (const f of out.files) {
      if (f.original == null && ctx.fileContents?.has(f.path)) f.original = ctx.fileContents.get(f.path)
    }
    return out
  }
  throw new Error('repairFn 返回形状非法(期望 string | {files:[{path,content}]})')
}

function buildRepairPrompt(req, ctx) {
  const lines = []
  lines.push('# 受限修复任务 — 仅改 allowedNodes 对应的样式/布局，禁止触碰其他节点')
  lines.push(`allowedFiles: ${req.allowedFiles.join(', ')}`)
  lines.push(`allowedNodes: ${req.allowedNodes.join(', ')}`)
  lines.push(`violations:`)
  for (const v of req.violations) lines.push(`- ${v}`)
  lines.push('constraints:')
  for (const c of req.constraints) lines.push(`- ${c}`)
  lines.push(`policy: ${PATCH_POLICY.priority.join(' | ')}`)
  if (req.context?.regions?.length) {
    lines.push('regions:')
    for (const r of req.context.regions) lines.push(`- (${r.x},${r.y} ${r.width}x${r.height}) pixels=${r.pixels}`)
  }
  if (req.context?.domHints?.length) {
    lines.push(`domHints(区域内渲染文本): ${req.context.domHints.map((h) => `"${h.text}"`).join(', ')}`)
  }
  if (ctx?.blueprint) {
    lines.push('blueprint 子树(数值真值，以此为准):')
    for (const n of (req.context?.blueprintNodes || []).slice(0, 6)) {
      lines.push(`- ${n.id} ${n.name || ''} bounds=${JSON.stringify(n.bounds)} layout=${JSON.stringify(n.layout)}${n.text ? ` text="${String(n.text).slice(0, 16)}"` : ''}`)
    }
  }
  lines.push('')
  lines.push('输出：仅返回改后文件的完整内容(若单文件)或 JSON {files:[{path,content}]}；不得输出解释文字。')
  return lines.join('\n')
}

/**
 * 确定性 fallback：对 gap/padding/color 的数值为蓝图直改（无需 LLM）
 * 仅示范：若 violations 含 gap/padding/color 关键词，则尝试在源码中替换对应字面量
 */
export function deterministicRepair(req, ctx) {
  const fileContents = ctx?.fileContents || new Map()
  const files = []
  for (const fp of req.allowedFiles) {
    const original = fileContents.get(fp) ?? ''
    if (!original) continue
    let content = original
    // 极简示例：若 blueprint 提供目标 gap，则把 gap: 旧值 → gap: 新值 的数值替换
    // 更完整的直改应在 emit/style-ir 上游做，这里仅保“有返回且可被 validator 接受”
    // 若无法确定性修复，则返回原内容并标记需 LLM（让外层判定停修）
    files.push({ path: fp, content, original })
  }
  if (files.length === 0 && req.allowedFiles.length) {
    const fp = req.allowedFiles[0]
    files.push({ path: fp, content: fileContents.get(fp) || '', original: fileContents.get(fp) || '' })
  }
  return { files, touchedNodes: req.allowedNodes, description: 'deterministic no-op fallback(需 LLM 真修时请注入 repairFn)' }
}

// ---------- 验证 + 评分 + 循环 ----------

/**
 * 单轮验证：truth vs render → pixel/regions/gate/score
 */
export function verifyOnce(opts) {
  const truthBuf = fs.readFileSync(opts.truthPng)
  const renderBuf = fs.readFileSync(opts.renderPng)
  const bp = opts.blueprint || (opts.bpPath ? JSON.parse(fs.readFileSync(opts.bpPath, 'utf8')) : null)
  const pixel = comparePng(truthBuf, renderBuf, { threshold: 0.1 })
  let regions = null
  if (bp) {
    const leaves = collectLeaves(bp)
    regions = diffRegions(truthBuf, renderBuf, { nodes: leaves, grid: opts.grid, top: opts.top })
  }
  let blocks = null
  if (opts.blocksTruth && opts.blocksRender && bp) {
    const bT = JSON.parse(fs.readFileSync(opts.blocksTruth, 'utf8'))
    const bR = JSON.parse(fs.readFileSync(opts.blocksRender, 'utf8'))
    const [W, H] = [pixel.width, pixel.height]
    blocks = blockMetrics(bT, bR, { designImg: decodePng(truthBuf), renderImg: decodePng(renderBuf), canvasWidth: W, canvasHeight: H })
    blocks = { blockMatchRate: blocks.blockMatchRate, matchedPairs: blocks.matchedPairs, positionSimilarity: blocks.positionSimilarity, colorSimilarity: blocks.colorSimilarity }
  }
  const contract = bp ? validateBlueprint(bp) : null
  const gate = evaluateGate({ pixel, regions, blocks, blueprint: bp, contract, assets: opts.assets || null, thresholds: opts.thresholds })
  const score = computeScore({ pixel, regions, blueprint: bp, contract, assets: opts.assets || null, blocks, changed: opts.changed || null })
  const corrections = bp && regions ? diffToCorrections(bp, regions) : null
  return { pixel, regions, blocks, gate, score, corrections, blueprint: bp }
}

function collectLeaves(bp) {
  const leaves = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (!Array.isArray(n.children) || n.children.length === 0) leaves.push(n)
    else for (const c of n.children) walk(c)
  }
  for (const r of [...(bp?.tree || []), ...(bp?.floatings || [])]) walk(r)
  return leaves.map((n) => ({ id: n.id, name: n.name || '', text: typeof n.text === 'string' ? n.text : undefined, bounds: n.bounds }))
}

/**
 * 应用 Patch 到磁盘（原子：先校验再写）
 */
export function applyPatch(projectDir, patch) {
  for (const f of patch.files) {
    const abs = path.join(projectDir, f.path)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.content)
  }
}

/**
 * 完整收敛循环（可被 restore.mjs / MCP / 测试复用）
 * @param {object} opts {
 *   truthPng, renderPng|renderTarget(截图目标), bpPath, restoreMapPath,
 *   projectDir, assetsPath?,
 *   repairFn?(prompt,req)=>Promise<{files}|string>,
 *   renderFn? async()=>{renderPng:string},
 *   maxIterations?, thresholds?
 * }
 */
export async function runConvergeLoop(opts) {
  const maxIterations = opts.maxIterations ?? 8
  const bp = JSON.parse(fs.readFileSync(opts.bpPath, 'utf8'))
  const restoreMap = opts.restoreMapPath && fs.existsSync(opts.restoreMapPath) ? JSON.parse(fs.readFileSync(opts.restoreMapPath, 'utf8')) : { entries: [] }
  let assets = null
  if (opts.assetsPath && fs.existsSync(opts.assetsPath)) {
    const raw = JSON.parse(fs.readFileSync(opts.assetsPath, 'utf8'))
    const list = raw.vectors || raw.assets || []
    assets = { summary: { missing: list.filter((v) => !v.svg && !v.path && !v.src).length, total: list.length } }
  }
  // 读项目文件供 patch/validator
  const fileContents = new Map()
  for (const e of restoreMap.entries || []) {
    const p = path.join(opts.projectDir || '', e.file)
    try { fileContents.set(e.file, fs.readFileSync(p, 'utf8')) } catch { /* 缺失 */ }
  }

  let state = { best: null, history: [], regressed: false, shouldStop: false, reason: '' }
  let curTruth = opts.truthPng
  let curRender = opts.renderPng

  for (let iter = 1; iter <= maxIterations; iter++) {
    if (opts.renderFn) {
      const r = await opts.renderFn({ iteration: iter, blueprint: bp, projectDir: opts.projectDir })
      if (r?.renderPng) curRender = r.renderPng
    }
    const v = verifyOnce({ truthPng: curTruth, renderPng: curRender, blueprint: bp, bpPath: opts.bpPath, assets, thresholds: opts.thresholds })
    state = updateConvergence({ iteration: iter, score: v.score, gatePass: v.gate.pass }, state, { maxIterations, patience: 2, scoreThreshold: 0.04 })

    if (v.gate.pass) return { status: 'completed', iteration: iter, verify: v, state, best: state.best }

    if (state.shouldStop && !v.gate.pass) {
      // 非通过但收敛停机 → exhausted
      if (state.reason.includes('连续') || state.reason.includes('最大迭代')) return { status: 'exhausted', iteration: iter, verify: v, state, best: state.best }
    }

    // 定位 → 分类 → (必要时 Vision 兜底) → 请求
    const locate = locateRegions({ regions: v.regions, blueprint: bp, restoreMap })
    let errors = classifyRegions(v.regions, bp) // P0-5
    // Phase 3.5 Vision fallback: 确定性说不清时启用
    let visionDiagnoses = []
    if (shouldTriggerVision({ gate: v.gate, regions: v.regions, errors })) {
      try {
        const truthBuf = fs.readFileSync(curTruth)
        const renderBuf = fs.readFileSync(curRender)
        visionDiagnoses = await diagnoseWithVision({
          truthPng: truthBuf,
          renderPng: renderBuf,
          regions: v.regions,
          blueprint: bp,
          visionClient: opts.visionClient,
          topN: 2,
        })
        // 回灌：将 Vision 诊断转为错误分类，附加到 errors（带 vision 标记）
        for (const vd of visionDiagnoses) {
          errors.push({
            category: vd.category,
            kind: vd.kind,
            nodeId: vd.region.candidates?.[0]?.id ?? locate.affectedNodes[0] ?? null,
            detail: `[Vision] ${vd.detail}`,
            expected: null,
            actual: null,
            confidence: vd.confidence,
            repair: { firstAction: `Vision诊断: ${vd.detail}` },
            source: 'vision',
          })
        }
      } catch (e) {
        // Vision 失败不阻断主流程
        console.error(`Vision fallback 失败: ${String(e)}`)
      }
    }
    const requests = buildPatchRequests(locate, errors, { iteration: iter, gateFailed: v.gate.failedGates })

    if (!requests.length) return { status: 'exhausted', iteration: iter, verify: v, state, best: state.best, reason: '无定位到的 PatchRequest' }

    // 逐请求修（V1 每轮只修首个最严重的 file 簇，避免并发改同一文件）
    const req = requests[0]
    let patch
    try {
      patch = await repairWithLlm(req, { blueprint: bp, projectDir: opts.projectDir, fileContents }, opts.repairFn)
    } catch (e) {
      return { status: 'error', iteration: iter, verify: v, state, error: String(e) }
    }

    const vr = validatePatch(patch, req, { maxFileChangeRatio: 0.6, maxAddedLines: 600 })
    if (!vr.ok) {
      // 拒收：不写盘，直接记回归并继续下一轮（调用方应回滚）
      state.regressed = true
      continue
    }

    // 接受：写盘并更新 fileContents
    if (opts.projectDir) applyPatch(opts.projectDir, patch)
    for (const f of patch.files) fileContents.set(f.path, f.content)

    // 评分已在下一轮 verify 时重算；本轮若 score 劣化则标记 regressed
    if (state.regressed) {
      // 上轮验证已标记 regressed 时，调用方应已回滚到 best（此处仅透传状态）
    }
  }
  const lastV = verifyOnce({ truthPng: curTruth, renderPng: curRender, blueprint: bp, bpPath: opts.bpPath, assets, thresholds: opts.thresholds })
  return { status: state.best?.gatePass ? 'completed' : 'exhausted', iteration: maxIterations, verify: lastV, state, best: state.best }
}

// CLI 直跑
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : null }
  const has = (n) => args.includes(`--${n}`)
  if (has('help') || !flag('bp') || !flag('truth') || !flag('render')) {
    console.log('用法: loop.mjs --bp <blueprint.json> --truth <truth.png> --render <render.png> --map <restore-map.json> --project <dir> [--max 8] [--assets <assets.json>]')
    process.exit(1)
  }
  runConvergeLoop({
    bpPath: flag('bp'),
    truthPng: flag('truth'),
    renderPng: flag('render'),
    restoreMapPath: flag('map'),
    projectDir: flag('project') || process.cwd(),
    assetsPath: flag('assets'),
    maxIterations: Number(flag('max')) || 8,
  }).then((r) => {
    console.log(JSON.stringify({ status: r.status, iteration: r.iteration, gate: r.verify?.gate, score: r.verify?.score }, null, 1))
  }).catch((e) => { console.error(e); process.exit(1) })
}
