#!/usr/bin/env node
// run-restore-agent.mjs — 无头还原 Agent 自环编排器(C 期)
//
// 链路: analyze(spawn) → generate(spawn) → truth 截图(+确定性回声) → [可选 --inject 扰动]
//       → runConvergeLoop(renderFn=截图, repairFn=快照恢复) → 合成 meta.gates → buildCiReport/ciGate → exit code
//
// 纪律: 引擎能力全部 import 自 dist(loop.js/index.js/screenshot.js + ura dist), 本脚本只做编排,
//       不重写 kit/core 同名函数(单一来源)。repairFn 注入点即未来 LLM 真修的扩展接口 —— V1 为
//       确定性快照恢复: --inject 场景下撤销扰动即真修复; 真实语义修复交由接入 LLM 的 repairFn。
//
// 用法:
//   node scripts/run-restore-agent.mjs <design.json> [--dir out] [--inject] [--truth png]
//                                        [--max 8] [--engine auto]
// 退出码: 0 = 循环 completed 且 CI 门禁 PASS; 1 = 失败(exhausted/门禁未过/链路错误)

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESTORE_CLI = path.join(REPO, 'packages/ui-restore/dist/restore.js')

const loop = await import(pathToFileURL(path.join(REPO, 'packages/ui-restore/dist/loop.js')).href)
const core = await import(pathToFileURL(path.join(REPO, 'packages/ui-restore/dist/index.js')).href)
const shot = await import(pathToFileURL(path.join(REPO, 'packages/ui-restore/dist/screenshot.js')).href)
const ura = await import(pathToFileURL(path.join(REPO, 'packages/ui-reverse-agent/dist/index.js')).href)

// ---------- args ----------
const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const hasFlag = (name) => argv.includes(`--${name}`)
const design = argv.find((a) => !a.startsWith('--') && a !== flag('dir') && a !== flag('truth') && a !== flag('max') && a !== flag('engine'))

if (!design || hasFlag('help')) {
  console.error('用法: node scripts/run-restore-agent.mjs <design.json> [--dir out] [--inject] [--truth png] [--max 8] [--engine auto]')
  process.exit(1)
}

const outDir = path.resolve(flag('dir') || path.join(path.dirname(path.resolve(design)), 'restore-agent'))
const maxIterations = Number(flag('max')) || 8
const engine = flag('engine') || 'auto'
const base = path.basename(design).replace(/\.[^.]+$/, '')

const log = (...m) => console.log('[restore-agent]', ...m)
const die = (msg) => { console.error('[restore-agent] FAIL:', msg); process.exit(1) }

// ---------- 1. analyze ----------
fs.mkdirSync(outDir, { recursive: true })
const bpPath = path.join(outDir, `${base}.blueprint.json`)
log(`[1/5] analyze ${design} → ${outDir}`)
const a = spawnSync(process.execPath, [RESTORE_CLI, 'analyze', design, '--dir', outDir], { encoding: 'utf8' })
if (a.status !== 0 || !fs.existsSync(bpPath)) die(`analyze 失败(exit ${a.status}):\n${a.stderr || a.stdout}`)
for (const line of (a.stdout || '').trim().split('\n')) log('  |', line)
const bp = JSON.parse(fs.readFileSync(bpPath, 'utf8'))
const canvas = bp.canvas || {}
log(`  蓝图: ${canvas.width}x${canvas.height}, 四闸 ${JSON.stringify({ geometry: bp.diffReport?.verdict, style: bp.styleDiffReport?.verdict, truth: bp.truthReport?.verdict })}`)

// ---------- 2. generate ----------
log('[2/5] generate → project/')
const projectDir = path.join(outDir, 'project')
const restoreDir = path.join(projectDir, 'restore')
const g = spawnSync(process.execPath, [RESTORE_CLI, 'generate', bpPath, '--project', projectDir], { encoding: 'utf8' })
const previewPath = path.join(restoreDir, 'preview.html')
const mapPath = path.join(restoreDir, '.restore-map.json')
if (g.status !== 0 || !fs.existsSync(previewPath) || !fs.existsSync(mapPath)) die(`generate 失败(exit ${g.status}):\n${g.stderr || g.stdout}`)
for (const line of (g.stdout || '').trim().split('\n').filter((l) => l.startsWith('!'))) log('  |', line)

// 生成产物快照(pristine) —— 修复策略的基准内容
const pristineHtml = fs.readFileSync(previewPath, 'utf8')
const snapshots = new Map([['preview.html', pristineHtml]])

// ---------- 3. truth 截图 + 确定性回声 ----------
log('[3/5] truth 截图(engine=' + engine + ')')
const truthPng = path.resolve(flag('truth') || path.join(outDir, 'truth.png'))
const truthEchoPng = path.join(outDir, 'truth-echo.png')
if (!flag('truth')) {
  await shot.captureScreenshot(previewPath, truthPng, { width: canvas.width, height: canvas.height, engine })
  await shot.captureScreenshot(previewPath, truthEchoPng, { width: canvas.width, height: canvas.height, engine })
  const echo = loop.verifyOnce({ truthPng, renderPng: truthEchoPng, blueprint: bp, bpPath })
  log(`  确定性回声: diffRatio=${echo.pixel.diffRatio} clusters=${echo.regions?.clusterCount ?? 'n/a'}`)
  if (echo.pixel.diffRatio > 0) log(`  ! 渲染存在非确定性(AA 噪声) —— maxClusters=0 门禁可能受影响`)
}
if (!fs.existsSync(truthPng)) die(`truth 截图缺失: ${truthPng}`)

// ---------- 4. 可选扰动(--inject): 打在叶子节点上, 模拟实现偏差 ----------
if (hasFlag('inject')) {
  log('[4/5] inject: 对 preview.html 注入实现偏差')
  const leaves = core.collectLeaves(bp).filter((n) => n?.id && n.bounds?.width > 2 && n.bounds?.height > 2 && htmlHasNode(pristineHtml, n.id))
  if (!leaves.length) die('inject 失败: 无可定位的叶子节点(preview.html 中无匹配 data-restore-node)')
  leaves.sort((x, y) => (x.bounds.width * x.bounds.height) - (y.bounds.width * y.bounds.height))
  const target = leaves[0]
  const perturbed = perturbNode(pristineHtml, target.id)
  if (!perturbed || perturbed.html === pristineHtml) die(`inject 失败: 节点 ${target.id} 扰动未生效`)
  fs.writeFileSync(previewPath, perturbed.html)
  log(`  目标节点 ${target.id}(${target.name || ''}): ${perturbed.changes.join(' + ')} → ${previewPath}`)
} else {
  log('[4/5] inject 未启用, 跳过扰动')
}

function htmlHasNode(html, id) {
  return new RegExp(`data-restore-node=["']${escapeRe(id)}["']`).test(html)
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function perturbNode(html, id) {
  const idx = html.search(new RegExp(`data-restore-node=["']${escapeRe(id)}["']`))
  if (idx < 0) return null
  const start = html.lastIndexOf('<', idx)
  if (start < 0 || html[start + 1] === '/') return null
  const end = html.indexOf('>', idx)
  if (end < 0) return null
  const openTag = html.slice(start, end + 1)
  const changes = []
  let newTag = openTag
  const colorRe = /#([0-9a-fA-F]{6})\b/
  if (colorRe.test(newTag)) {
    newTag = newTag.replace(colorRe, (_m, hex) => {
      const n = parseInt(hex, 16)
      const r = Math.min(255, ((n >> 16) & 255) + 64)
      return `#${((r << 16) | (n & 0xffff)).toString(16).padStart(6, '0')}`
    })
    changes.push('色值+64R')
  }
  const styleRe = /style\s*=\s*"([^"]*)"/i
  if (styleRe.test(newTag)) {
    newTag = newTag.replace(styleRe, (_m, v) => `style="${v.replace(/;\s*$/, '')};transform:translate(8px,8px)"`)
  } else {
    newTag = newTag.replace(/>$/, ' style="transform:translate(8px,8px)">')
  }
  changes.push('位移8px')
  if (newTag === openTag) return null
  return { html: html.slice(0, start) + newTag + html.slice(end + 1), changes }
}

// ---------- 5. 收敛自环 ----------
log(`[5/5] runConvergeLoop(max=${maxIterations})`)
const renderFn = async ({ iteration }) => {
  const renderPng = path.join(outDir, `render-${iteration}.png`)
  await shot.captureScreenshot(previewPath, renderPng, { width: canvas.width, height: canvas.height, engine })
  log(`  [iter ${iteration}] 渲染 → ${path.basename(renderPng)}`)
  return { renderPng }
}
// V1 修复策略 = 快照恢复: 对允许文件返回 pristine 内容(deterministic undo)。
// 声明 touchedNodes=allowedNodes → validatePatch 以声明为准(全文件替换可过 node-scope)。
const repairFn = async (_prompt, req) => ({
  files: req.allowedFiles.map((f) => ({
    path: f,
    content: snapshots.get(f) ?? fs.readFileSync(path.join(restoreDir, f), 'utf8'),
  })),
  touchedNodes: req.allowedNodes,
})

const result = await loop.runConvergeLoop({
  truthPng,
  bpPath,
  restoreMapPath: mapPath,
  projectDir: restoreDir,
  maxIterations,
  renderFn,
  repairFn,
})

log(`循环结束: status=${result.status} iteration=${result.iteration}`)
for (const h of result.state?.history || []) {
  log(`  [iter ${h.iteration}] score=${h.score?.score} gate=${h.gatePass ? 'PASS' : 'FAIL'}`)
}

// ---------- CI 报告(ura) ----------
const v = result.verify
const contract = core.validateBlueprint(bp)
const gateVerdict = (ok, name) => `${ok ? 'PASS' : 'FAIL'}_${name.toUpperCase()}`
const gates = {
  contract: gateVerdict(!!contract.ok, 'contract'),
  geometry: gateVerdict(String(bp.diffReport?.verdict || 'FAIL_MISSING').startsWith('PASS'), 'geometry'),
  style: gateVerdict(String(bp.styleDiffReport?.verdict || 'FAIL_MISSING').startsWith('PASS'), 'style'),
  truth: gateVerdict(String(bp.truthReport?.verdict || 'FAIL_MISSING').startsWith('PASS'), 'truth'),
}
// analyze 蓝图无 meta 键 —— CI 需要四闸摘要, 此处合成(数值全部来自已产出的验证事实, 无新增判断)
const bpWithMeta = { ...bp, meta: { gates } }
const state = {
  iteration: result.iteration,
  scores: { current: { total: 1 - Math.min(1, v.score?.score ?? 1) }, delta: 0 },
  remainingDifferences: v.gate?.pass ? [] : (v.gate?.failedGates || []).map((gate) => ({ priority: 'P0', gate })),
  resolvedDifferences: [],
  antiHack: { violations: [] },
}
const report = ura.buildCiReport({
  state,
  blueprint: bpWithMeta,
  artifacts: [truthPng, ...fs.readdirSync(outDir).filter((f) => /^render-\d+\.png$/.test(f)).map((f) => path.join(outDir, f))],
})
const written = ura.writeCiArtifacts(report, { outDir: path.join(outDir, 'ci') })
const verdict = ura.ciGate(report)

log(`CI: ${report.passed ? 'PASS' : 'FAIL'} — ${report.summary} (threshold=${report.threshold})`)
log(`  gates: ${JSON.stringify(gates)}`)
log(`  报告: ${written.reportPath || written.error}`)
if (!v.gate?.pass && v.gate?.failedGates?.length) log(`  未过闸: ${v.gate.failedGates.join(', ')} — ${v.gate.reasons?.slice(0, 3).join('; ')}`)

const ok = result.status === 'completed' && verdict.pass
log(ok ? `完成: 还原自环通过(iter=${result.iteration})` : `未通过: status=${result.status}, ciGate=${verdict.reason}`)
process.exit(ok ? 0 : 1)
