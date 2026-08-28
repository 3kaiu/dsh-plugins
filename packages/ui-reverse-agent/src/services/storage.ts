'use strict'
// Storage — artifacts 热图/blueprint 的持久化抽象
// 优先 DSH storage（dsh-storage / ctx.storage），其次文件系统 .ui-reverse/artifacts
// 大 PNG 走 spill（若可用），小 JSON 走 storage json domain

import fs from 'node:fs'
import path from 'node:path'

function detectStorage(ctx) {
  if (!ctx) return { available: false, storage: null }
  const s = ctx.storage || (ctx.get && (() => { try { return ctx.get('storage') } catch { return null } })()) || null
  const alt = !s && ctx.get ? (() => { try { return ctx.get('dsh-storage') } catch { return null } })() : null
  const svc = s || alt
  return { available: !!svc && typeof svc.get === 'function', storage: svc }
}

export function storageKeyForArtifact(kind, viewport, state) {
  // kind: blueprint / diff / current / baseline
  return `ui-reverse:${kind}:${viewport}:${state || 'default'}`
}

/**
 * 保存 artifact（热图 PNG 路径或 JSON）
 * @param ctx DSH ctx（可选）
 * @param {key, filePath, value, domain} 三选一：filePath 为本地文件，value 为 JSON
 */
export async function persistArtifact(ctx, { key, filePath, value, domain = 'ui-reverse' }) {
  const { available, storage } = detectStorage(ctx)
  // 文件路径：若 storage 可用且文件较大（>64k），走 spill 语义（storage 下的 binary domain）
  if (filePath) {
    try {
      const buf = fs.readFileSync(filePath)
      if (available && buf.length > 64 * 1024 && storage.spill) {
        try {
          const id = await storage.spill(buf, { key, domain })
          return { stored: true, via: 'spill', id, bytes: buf.length }
        } catch {}
      }
      if (available && storage.set) {
        try { await storage.set(key, { filePath, bytes: buf.length, at: new Date().toISOString() }, domain); return { stored: true, via: 'storage', bytes: buf.length } } catch {}
      }
    } catch {}
    return { stored: false, via: 'fs', filePath }
  }
  if (value !== undefined) {
    if (available && storage.set) {
      try { await storage.set(key, value, domain); return { stored: true, via: 'storage' } } catch {}
    }
    // 回退：写 .ui-reverse/storage.json
    try {
      const dir = '.ui-reverse'
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const p = path.join(dir, 'storage.json')
      const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}
      cur[key] = value
      fs.writeFileSync(p, JSON.stringify(cur, null, 2))
      return { stored: true, via: 'fs-json', file: p }
    } catch (e) {
      return { stored: false, error: String(e) }
    }
  }
  return { stored: false, error: 'no filePath nor value' }
}

/**
 * 读取 artifact
 */
export async function retrieveArtifact(ctx, key, domain = 'ui-reverse') {
  const { available, storage } = detectStorage(ctx)
  if (available && storage.get) {
    try { const v = await storage.get(key, domain); if (v !== undefined) return { value: v, via: 'storage' } } catch {}
  }
  try {
    const p = path.join('.ui-reverse', 'storage.json')
    if (fs.existsSync(p)) {
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (cur[key] !== undefined) return { value: cur[key], via: 'fs-json' }
    }
  } catch {}
  return { value: undefined, via: 'none' }
}
