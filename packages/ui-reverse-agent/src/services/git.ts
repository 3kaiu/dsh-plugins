'use strict'
// git — 分支/回滚/PR 与 state rollbackPoints 联动（Phase5/7 的 git 锚点）
// 封装：createBranch / commit / rollback / diff（基于 spawn git，无外部依赖）

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

function git(args: any, cwd = process.cwd()) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { ok: res.status === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim(), status: res.status }
}

export function gitStatus(cwd: any) {
  const r = git(['status', '--porcelain'], cwd)
  return { clean: r.stdout === '', dirtyFiles: r.stdout ? r.stdout.split('\n') : [], raw: r.stdout }
}

export function gitCreateBranch(name: any, cwd: any) {
  const r = git(['checkout', '-b', name], cwd)
  return { ok: r.ok, branch: name, stdout: r.stdout, stderr: r.stderr }
}

export function gitCommit(message: any, cwd: any) {
  const add = git(['add', '-A'], cwd)
  if (!add.ok) return add
  const commit = git(['commit', '-m', message], cwd)
  return commit
}

export function gitRollback(to: any, cwd: any) {
  // to: commit sha 或 HEAD~1 或分支名
  const r = git(['checkout', to, '--', '.'], cwd) // 恢复工作区到 to 的内容
  if (!r.ok) return r
  const reset = git(['reset', 'HEAD', '.'], cwd)
  return { ok: reset.ok, to, stdout: reset.stdout }
}

export function gitDiffStat(cwd: any) {
  const r = git(['diff', '--stat'], cwd)
  return r.stdout
}

export function ensureRollbackPoint(state: any, cwd = process.cwd()) {
  const status = gitStatus(cwd)
  const head = git(['rev-parse', 'HEAD'], cwd)
  const point = {
    iteration: state.iteration ?? 0,
    git: head.ok ? head.stdout.slice(0, 7) : 'unknown',
    clean: status.clean,
    at: new Date().toISOString(),
    dirtyFiles: status.dirtyFiles.slice(0, 10),
  }
  return point
}
