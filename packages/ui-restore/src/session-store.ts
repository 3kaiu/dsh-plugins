// session-store — RestoreSession 存取单一来源(收敛自 adapters/restore.ts 与 adapters/mcp-server.ts 两份拷贝)
//
// 会话即单个 JSON 文件(无数据库无队列, d2c 第六节)。两处原实现语义曾分叉:
// restore 版 loadSession 缺文件时自动建骨架, mcp 版返回 null —— 用 create 选项显式区分。
// 层规则: 会话路径的收容在入口完成(MCP 已 confineUnder), 本模块信任传入路径。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 读会话。缺文件时: create=true 则写入初始骨架并返回(restore CLI 语义), 否则返回 null(MCP 语义)。
 */
export function loadSession(p: any, { create = false }: Record<string, any> = {}) {
  if (!p) return null
  if (!fs.existsSync(p)) {
    if (!create) return null
    const s = { createdAt: new Date().toISOString(), iteration: 0, status: 'analyzing', phases: {} }
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(s, null, 1))
    return s
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/**
 * 合并写会话: 缺文件以 {createdAt} 骨架起底, 深浅合并 patch, 盖 updatedAt, 自动建父目录。
 */
export function saveSession(p: any, patch: any) {
  const s = { ...(loadSession(p) || { createdAt: new Date().toISOString() }), ...patch, updatedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(s, null, 1))
  return s
}
