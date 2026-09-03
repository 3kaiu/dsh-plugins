'use strict'
// Memory.State：UI Reconstruction State（append-only）
// 双后端：
//  - 宿主挂载 dsh-storage（ctx.storageDomain）时 → 开 `ui-reverse-state` domain，
//    global 单槽存整份 state，写入走宿主持久写链（原子 + durable + domain/changed 事件）
//  - 缺席时 → fs 回退：<项目根>/.ui-reverse/state.json + history/ + artifacts/
// initStorageBackend(ctx) 在 apply 时探测；open 失败/未挂载自动留在 fs 后端。

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const STATE_PATH = '.ui-reverse/state.json'
const HISTORY_DIR = '.ui-reverse/history'

// state 形态随版本演进：顶层 loose（未知键透传，防 strip 静默丢字段），null 必须被拒
// （storage-domain 以 null 为"从未写入"哨兵，global schema 接受 null 会在 open 时抛错）
const STATE_GLOBAL_SCHEMA = z.looseObject({})

// 宿主 facility 注入点（initStorageBackend 设置）
let domainFacility = null
let domainHandle = null
let domainInitialRef = null // spec.global.initial 引用：facility 在首次 set 前原样返回它，据此判"从未写入"
const DOMAIN_NAME = 'ui-reverse-state'
const DOMAIN_VERSION = 1

/**
 * 探测并打开 storage domain（fire-and-forget：open 完成前读取走 fs 回退）
 * @returns Promise<Domain|null>
 */
export function initStorageBackend(ctx: any) {
  try {
    const facility = ctx?.storageDomain
      || (typeof ctx?.get === 'function' && (() => { try { return ctx.get('storageDomain') } catch { return null } })())
      || null
    if (!facility || typeof facility.open !== 'function') return Promise.resolve(null)
    domainFacility = facility
    const spec = {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      global: { schema: STATE_GLOBAL_SCHEMA, initial: defaultState() },
      tables: {},
    }
    domainInitialRef = spec.global.initial
    return Promise.resolve(facility.open(spec))
      .then((h) => { domainHandle = h; return h })
      .catch((e) => {
        // 打开失败：回到 fs 后端（清掉可能残留的旧 handle），不阻塞插件加载
        domainFacility = null
        domainHandle = null
        console.warn(`[ui-reverse] storage domain 不可用(${String(e).slice(0, 120)})，state 回退 fs`)
        return null
      })
  } catch (e) {
    console.warn(`[ui-reverse] storage domain 探测失败: ${String(e).slice(0, 120)}`)
    return Promise.resolve(null)
  }
}

export function storageBackendName() {
  return domainHandle ? 'storage-domain' : 'fs'
}

function ensureDir(p: any) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }) } catch {}
}

export function defaultState(project: Record<string, any> = {}) {
  return {
    $schema: 'ui-reconstruction-state/1',
    project: { path: project.path || '', framework: project.framework || '', devCommand: project.devCommand || '', url: project.url || '' },
    reference: { source: '', files: [], viewports: [{ name: 'desktop', width: 1440, height: 900 }], states: ['default'], blueprintPath: '.ui-reverse/blueprint.json' },
    viewport: 'desktop-1440x900',
    state: 'default',
    iteration: 0,
    scores: { current: { total: 0 }, previous: { total: 0 }, delta: 0, history: [] },
    resolvedDifferences: [],
    remainingDifferences: [],
    knownConstraints: [],
    implementedComponents: [],
    knownAssets: [],
    typographyProfile: {},
    layoutDecisions: [],
    rollbackPoints: [],
    lastChanges: [],
    antiHack: { lastScan: 'unknown', violations: [] },
  }
}

export function stateRead({ statePath }: Record<string, any> = {}) {
  // domain 后端：global 未写入时 facility 返回 initial（= defaultState），语义即 exists:false
  if (domainHandle) {
    try {
      const v = domainHandle.global.get()
      if (v !== domainInitialRef && v && typeof v === 'object' && !Array.isArray(v)) {
        return { exists: true, state: v, path: `storage-domain:${DOMAIN_NAME}`, backend: 'storage-domain' }
      }
      return { exists: false, state: defaultState(), path: `storage-domain:${DOMAIN_NAME}`, backend: 'storage-domain' }
    } catch (e) {
      return { exists: false, error: String(e), state: defaultState(), path: `storage-domain:${DOMAIN_NAME}`, backend: 'storage-domain' }
    }
  }
  const p = statePath || STATE_PATH
  try {
    if (!fs.existsSync(p)) return { exists: false, state: defaultState(), path: p, backend: 'fs' }
    const raw = fs.readFileSync(p, 'utf8')
    const state = JSON.parse(raw)
    return { exists: true, state, path: p, backend: 'fs' }
  } catch (e) {
    return { exists: false, error: String(e), state: defaultState(), path: p, backend: 'fs' }
  }
}

function nextState(prev: any, patch: any) {
  const next = { ...prev, ...patch }
  // iteration 自增（若 patch 未显式指定）
  if (patch.iteration == null && prev.iteration != null) next.iteration = prev.iteration + 1
  else if (patch.iteration != null) next.iteration = patch.iteration

  // scores.history append-only 保留最近 50 轮
  if (patch.scores) {
    const hist = Array.isArray(prev.scores?.history) ? [...prev.scores.history] : []
    if (patch.scores.current) hist.push({ iteration: next.iteration, total: patch.scores.current.total, layers: patch.scores.current })
    if (hist.length > 50) hist.splice(0, hist.length - 50)
    next.scores = { ...prev.scores, ...patch.scores, history: hist }
    if (patch.scores.current && prev.scores?.current) {
      next.scores.previous = prev.scores.current
      next.scores.delta = Math.round(((patch.scores.current.total ?? 0) - (prev.scores.current.total ?? 0)) * 1000) / 1000
    }
  }
  return next
}

function writeHistoryEntry(next: any, patch: any, historyNote: any, p: any) {
  if (historyNote == null && patch.lastChanges == null) return
  const hdir = path.dirname(p) + '/history'
  ensureDir(hdir + '/x')
  const fname = `${String(next.iteration).padStart(4, '0')}-iteration.json`
  const entry = { iteration: next.iteration, timestamp: new Date().toISOString(), patch, note: historyNote || null, stateSnapshot: next }
  try { fs.writeFileSync(path.join(hdir, fname), JSON.stringify(entry, null, 2)) } catch {}
}

export async function stateUpdate(patch = {}, { statePath, historyNote }: Record<string, any> = {}) {
  const { state: prev } = stateRead({ statePath })
  const next = nextState(prev, patch)

  if (domainHandle) {
    // 宿主持久写链：global.set 原子且 durable（失败不落地，内存不动）
    await domainHandle.global.set(next)
    try { syncGoalsAndTodo(next, { statePath: statePath || STATE_PATH }) } catch {}
    writeHistoryEntry(next, patch, historyNote, statePath || STATE_PATH)
    return { state: next, path: `storage-domain:${DOMAIN_NAME}`, backend: 'storage-domain' }
  }

  const p = statePath || STATE_PATH
  ensureDir(p)
  fs.writeFileSync(p, JSON.stringify(next, null, 2))
  // 同步 goals/todo（Preset 增强，不抛异常）
  try { syncGoalsAndTodo(next, { statePath: p }) } catch {}
  writeHistoryEntry(next, patch, historyNote, p)
  return { state: next, path: p, backend: 'fs' }
}

export function appendHistory(entry: any, { statePath }: Record<string, any> = {}) {
  const p = statePath || STATE_PATH
  const hdir = path.dirname(p) + '/history'
  ensureDir(hdir + '/x')
  const iter = entry.iteration ?? Date.now()
  const fname = `${String(iter).padStart(4,'0')}-iteration.json`
  const hpath = path.join(hdir, fname)
  fs.writeFileSync(hpath, JSON.stringify(entry, null, 2))
  return hpath
}

// 辅助：更新剩余差异（按优先级排序）
export function sortDifferences(diffs: any) {
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 }
  return [...diffs].sort((a: any, b: any) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || (b.delta||0)-(a.delta||0))
}

// ── Goals / TODO 双写（Preset 增强） ───────────────────────────────
// DSH 原生无独立 goals/todo 服务（取决于宿主是否挂载 dsh-tool-*），这里同时做两件事：
// 1) 文件落盘：.ui-reverse/goals.json + todo.json（供 UI 直接读取，无需 ctx）
// 2) 若 ctx 上存在 goals/todo 服务则尝试同步（duck-typing，不抛异常）
export function syncGoalsAndTodo(state: any, { statePath }: Record<string, any> = {}) {
  const base = path.dirname(statePath || STATE_PATH)
  const goalsPath = path.join(base, 'goals.json')
  const todoPath = path.join(base, 'todo.json')
  const diffs = Array.isArray(state.remainingDifferences) ? state.remainingDifferences : []
  const sorted = sortDifferences(diffs)
  // goals：每个剩余差异映射为一个 goal，P0/P1 为 open，P2/P3 为 pending
  const goals = sorted.map((d: any, i: any) => ({
    id: `ui-${String(i+1).padStart(2,'0')}`,
    title: `${d.path} ${d.prop}: 期望 ${d.expected} vs 实际 ${d.actual} (Δ${d.delta ?? '?'})`,
    priority: d.priority || 'P2',
    status: i === 0 ? 'in_progress' : 'open',
    confidence: d.confidence ?? 1,
  }))
  // todo：首条 in_progress，其余 open；已解决差异对应 completed
  const todos = [
    ...goals.map(g => ({ id: g.id, title: g.title, status: g.status, priority: g.priority })),
    ...(Array.isArray(state.resolvedDifferences) ? state.resolvedDifferences.slice(-10).map((d: any, i: any) => ({
      id: `done-${d.iteration ?? i}`,
      title: `✓ ${d.path} ${d.prop}`,
      status: 'completed',
      priority: d.priority || 'P2',
    })) : []),
  ]
  try { ensureDir(goalsPath); fs.writeFileSync(goalsPath, JSON.stringify({ iteration: state.iteration, total: state.scores?.current?.total ?? 0, goals }, null, 2)) } catch {}
  try { ensureDir(todoPath); fs.writeFileSync(todoPath, JSON.stringify({ iteration: state.iteration, todos }, null, 2)) } catch {}
  // 额外：写入 markdown 便于 skill/人工阅读
  try {
    const mdPath = path.join(base, 'todo.md')
    const lines = [`# UI 还原 TODO (iteration ${state.iteration}  S=${state.scores?.current?.total ?? 0})`, '']
    for (const g of goals) lines.push(`- [${g.status === 'in_progress' ? 'x' : g.status === 'completed' ? 'x' : ' '}] [${g.priority}] ${g.title} (${g.id})`)
    if (state.resolvedDifferences?.length) {
      lines.push('', '## 已解决')
      for (const d of state.resolvedDifferences.slice(-5)) lines.push(`- [x] ${d.path} ${d.prop} (iter ${d.iteration})`)
    }
    fs.writeFileSync(mdPath, lines.join('\n'))
  } catch {}
  return { goalsPath, todoPath, goals, todos }
}
