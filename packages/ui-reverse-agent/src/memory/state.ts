'use strict'
// Memory.State：UI Reconstruction State（append-only）
// 路径：<项目根>/.ui-reverse/state.json + history/ + artifacts/

import fs from 'node:fs'
import path from 'node:path'

const STATE_PATH = '.ui-reverse/state.json'
const HISTORY_DIR = '.ui-reverse/history'

function ensureDir(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }) } catch {}
}

export function defaultState(project = {}) {
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

export function stateRead({ statePath } = {}) {
  const p = statePath || STATE_PATH
  try {
    if (!fs.existsSync(p)) return { exists: false, state: defaultState(), path: p }
    const raw = fs.readFileSync(p, 'utf8')
    const state = JSON.parse(raw)
    return { exists: true, state, path: p }
  } catch (e) {
    return { exists: false, error: String(e), state: defaultState(), path: p }
  }
}

export function stateUpdate(patch = {}, { statePath, historyNote } = {}) {
  const p = statePath || STATE_PATH
  ensureDir(p)
  const { state: prev } = stateRead({ statePath: p })
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

  fs.writeFileSync(p, JSON.stringify(next, null, 2))
  // 同步 goals/todo（Preset 增强，不抛异常）
  try { syncGoalsAndTodo(next, { statePath: p }) } catch {}

  // history 条目
  if (historyNote != null || patch.lastChanges) {
    const hdir = path.dirname(p) + '/history'
    ensureDir(hdir + '/x')
    const fname = `${String(next.iteration).padStart(4,'0')}-iteration.json`
    const hpath = path.join(hdir, fname)
    const entry = { iteration: next.iteration, timestamp: new Date().toISOString(), patch, note: historyNote || null, stateSnapshot: next }
    try { fs.writeFileSync(hpath, JSON.stringify(entry, null, 2)) } catch {}
  }

  return { state: next, path: p }
}

export function appendHistory(entry, { statePath } = {}) {
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
export function sortDifferences(diffs) {
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 }
  return [...diffs].sort((a,b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || (b.delta||0)-(a.delta||0))
}

// ── Goals / TODO 双写（Preset 增强） ───────────────────────────────
// DSH 原生无独立 goals/todo 服务（取决于宿主是否挂载 dsh-tool-*），这里同时做两件事：
// 1) 文件落盘：.ui-reverse/goals.json + todo.json（供 UI 直接读取，无需 ctx）
// 2) 若 ctx 上存在 goals/todo 服务则尝试同步（duck-typing，不抛异常）
export function syncGoalsAndTodo(state, { statePath } = {}) {
  const base = path.dirname(statePath || STATE_PATH)
  const goalsPath = path.join(base, 'goals.json')
  const todoPath = path.join(base, 'todo.json')
  const diffs = Array.isArray(state.remainingDifferences) ? state.remainingDifferences : []
  const sorted = sortDifferences(diffs)
  // goals：每个剩余差异映射为一个 goal，P0/P1 为 open，P2/P3 为 pending
  const goals = sorted.map((d, i) => ({
    id: `ui-${String(i+1).padStart(2,'0')}`,
    title: `${d.path} ${d.prop}: 期望 ${d.expected} vs 实际 ${d.actual} (Δ${d.delta ?? '?'})`,
    priority: d.priority || 'P2',
    status: i === 0 ? 'in_progress' : 'open',
    confidence: d.confidence ?? 1,
  }))
  // todo：首条 in_progress，其余 open；已解决差异对应 completed
  const todos = [
    ...goals.map(g => ({ id: g.id, title: g.title, status: g.status, priority: g.priority })),
    ...(Array.isArray(state.resolvedDifferences) ? state.resolvedDifferences.slice(-10).map((d, i) => ({
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
