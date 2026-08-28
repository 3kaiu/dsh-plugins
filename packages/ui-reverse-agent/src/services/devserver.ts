'use strict'
// DevServer 托管：启动子进程 + 健康检查 + 停止
import { spawn } from 'node:child_process'
import fs from 'node:fs'

export class DevServer {
  constructor({ command, cwd, port, env } = {}) {
    this.command = command // e.g. "pnpm dev" or "npm run dev"
    this.cwd = cwd || process.cwd()
    this.port = port
    this.env = env || {}
    this.proc = null
    this.url = null
  }

  async start({ timeoutMs = 30000 } = {}) {
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
    this.proc = spawn(cmd, args, { cwd: this.cwd, env: { ...process.env, ...this.env }, stdio: ['ignore','pipe','pipe'], shell: true })
    this.proc.stdout?.on('data', d => process.stderr.write(`[devserver] ${d}`))
    this.proc.stderr?.on('data', d => process.stderr.write(`[devserver:err] ${d}`))

    // 推断 URL
    const port = this.port || await this.detectPort()
    this.url = `http://localhost:${port}`
    if (port) {
      await this.waitForHealth(this.url, timeoutMs)
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

  async waitForHealth(url, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(url, { method: 'GET' })
        if (res.ok || res.status < 500) return
      } catch {}
      await new Promise(r=>setTimeout(r, 800))
    }
    // 超时不抛错，仅警告（调用方决定）
  }

  async stop() {
    if (!this.proc) return
    try { this.proc.kill('SIGTERM'); } catch {}
    this.proc = null
    this.url = null
  }
}
