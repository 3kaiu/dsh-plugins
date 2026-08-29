'use strict'
// DevServer 托管：启动子进程 + 健康检查 + 停止
import { spawn } from 'node:child_process'
import fs from 'node:fs'

export class DevServer {
  // JS 动态字段风格: 构造器内赋值, 显式声明供 tsc 识别
  command;
  cwd;
  port;
  env;
  proc = null;
  url = null;
  constructor({ command, cwd, port, env }: Record<string, any> = {}) {
    this.command = command // e.g. "pnpm dev" or "npm run dev"
    this.cwd = cwd || process.cwd()
    this.port = port
    this.env = env || {}
    this.proc = null
    this.url = null
  }

  async start({ timeoutMs = 30000, signal }: Record<string, any> = {}) {
    if (signal?.aborted) throw new Error('devserver start aborted before dispatch')
    if (!this.command) {
      // 尝试推断
      const pkgPath = `${this.cwd}/package.json`
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath,'utf8'))
        const scripts = pkg.scripts || {}
        if (scripts.dev) this.command = 'pnpm dev'
        else if (scripts.start) this.command = 'pnpm start'
        else throw new Error('no dev/start script')
      } catch (e) {
        throw new Error(`无法推断 dev 命令: ${e.message}`)
      }
    }
    const parts = this.command.split(' ')
    const cmd = parts[0], args = parts.slice(1)
    // detached: shell 进程成为进程组长, stop 时可整组杀死(官方 defensive-patterns:
    // "Dispose must reach quiescence" — 只 SIGTERM shell 会留孤儿 dev server)
    this.proc = spawn(cmd, args, { cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ['ignore','pipe','pipe'], shell: true, detached: process.platform !== 'win32' })
    this.proc.stdout?.on('data', d => process.stderr.write(`[devserver] ${d}`))
    this.proc.stderr?.on('data', d => process.stderr.write(`[devserver:err] ${d}`))

    // 推断 URL
    const port = this.port || await this.detectPort()
    this.url = `http://localhost:${port}`
    if (port) {
      await this.waitForHealth(this.url, timeoutMs, signal)
    }
    if (signal?.aborted) {
      // 调用方取消：不留下一个刚拉起的孤儿 dev server
      await this.stop()
      throw new Error('devserver start aborted')
    }
    return { url: this.url, pid: this.proc.pid }
  }

  async detectPort() {
    if (this.port) return this.port
    // 简化：默认 3000 / 5173 / 8080 探测
    for (const p of [3000,5173,8080,4173]) {
      if (await this.isPortFree(p) === false) return p // 已占用可能是 dev server
    }
    return 3000
  }

  async isPortFree(p) {
    try {
      const res = await fetch(`http://localhost:${p}`, { method: 'HEAD' })
      return false
    } catch { return true }
  }

  async waitForHealth(url, timeoutMs, signal) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) return
      try {
        const res = await fetch(url, { method: 'GET', signal })
        if (res.ok || res.status < 500) return
      } catch {}
      await new Promise(r=>setTimeout(r, 800))
    }
    // 超时不抛错，仅警告（调用方决定）
  }

  async stop({ timeoutMs = 5000 }: Record<string, any> = {}) {
    const proc = this.proc
    if (!proc) return { stopped: true }
    this.proc = null
    this.url = null
    if (proc.exitCode != null || proc.signalCode != null) return { stopped: true, alreadyExited: true }
    const killGroup = (sig) => {
      try { process.kill(-proc.pid, sig) } catch { try { proc.kill(sig) } catch {} }
    }
    const exited = new Promise((resolve) => { proc.once('exit', resolve); })
    killGroup('SIGTERM')
    const killTimer = setTimeout(() => killGroup('SIGKILL'), timeoutMs)
    try { await exited } finally { clearTimeout(killTimer) }
    return { stopped: true }
  }
}
