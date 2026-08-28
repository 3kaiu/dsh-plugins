'use strict'
// JobDevServer — DevServer 的 Jobs/Terminal 感知封装
// 宿主若提供 ctx.jobs / ctx.terminal（dsh-jobs/dsh-terminal），则以 Job 形式托管，日志进 terminal，供 ui-jobs 可视；否则回退到朴素 DevServer（src/services/devserver.ts）

import { DevServer } from './devserver.ts'

function detectJobs(ctx) {
  if (!ctx) return { available: false, jobs: null }
  const jobs = ctx.jobs || (ctx.get && (() => { try { return ctx.get('jobs') } catch { return null } })()) || null
  const alt = !jobs && ctx.get ? (() => { try { return ctx.get('dsh-jobs') } catch { return null } })() : null
  const svc = jobs || alt
  return { available: !!svc && typeof svc.run === 'function', jobs: svc }
}

function detectTerminal(ctx) {
  if (!ctx) return { available: false, terminal: null }
  const t = ctx.terminal || (ctx.get && (() => { try { return ctx.get('terminal') } catch { return null } })()) || null
  return { available: !!t, terminal: t }
}

export class JobDevServer {
  constructor({ command, cwd, port, env } = {}, ctx = null) {
    this.opts = { command, cwd, port, env }
    this.ctx = ctx
    this.inner = new DevServer(this.opts)
    this.jobId = null
    this.mode = 'raw' // 'job' | 'raw'
  }

  async start({ timeoutMs = 30000 } = {}) {
    const { available, jobs } = detectJobs(this.ctx)
    if (!available) {
      this.mode = 'raw'
      return this.inner.start({ timeoutMs })
    }
    // Jobs 路径：jobs.run 需支持 signal 与 onOutput（不同宿主实现差异大，此处做最大兼容）
    this.mode = 'job'
    const cmd = this.opts.command || 'pnpm dev'
    // 约定：jobs.run({ command, cwd, env, signal })
    try {
      const ac = new AbortController()
      const job = await jobs.run({
        command: cmd,
        cwd: this.opts.cwd,
        env: this.opts.env,
        signal: ac.signal,
      })
      this.jobId = job?.id || job?.jobId || 'devserver'
      // 若宿主提供 terminal，则把 job 输出桥到 terminal（不阻塞）
      const { available: termAvail, terminal } = detectTerminal(this.ctx)
      if (termAvail && terminal?.append && job?.output) {
        try { terminal.append(`[devserver job ${this.jobId}] ${cmd}\n`) } catch {}
      }
      // 健康检查仍复用 inner 的 waitForHealth（复用 port 探测）
      const port = this.opts.port || await this.inner.detectPort()
      this.inner.url = `http://localhost:${port}`
      this.inner.port = port
      await this.inner.waitForHealth(this.inner.url, timeoutMs)
      return { url: this.inner.url, pid: null, jobId: this.jobId, mode: 'job' }
    } catch (e) {
      // Jobs 启动失败则回退 raw
      this.mode = 'raw'
      return this.inner.start({ timeoutMs })
    }
  }

  async stop() {
    if (this.mode === 'job' && this.jobId && this.ctx) {
      const { available, jobs } = detectJobs(this.ctx)
      if (available && jobs?.kill) {
        try { await jobs.kill(this.jobId) } catch {}
      }
      this.jobId = null
      return
    }
    return this.inner.stop()
  }

  get url() { return this.inner.url }
  get proc() { return this.inner.proc }
}

// 宿主侧 Job 注册的探测辅助（供 preset 的 agent.cordis.yml 条件挂载参考）
export function describeJobSupport(ctx) {
  const { available } = detectJobs(ctx)
  const { available: tAvail } = detectTerminal(ctx)
  return { jobs: available, terminal: tAvail, recommendation: available ? 'Use JobDevServer (scoped, ui-jobs visible)' : 'Fallback to raw DevServer (process group)' }
}
