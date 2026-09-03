'use strict'
// cache — 增量与缓存（blueprint/compare 结果的失效策略）
// 键：基于 dsl hash + viewport + state；失效：dsl 变更或 tolerance 变更

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function hashOf(obj: any) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj)
  return createHash('md5').update(s).digest('hex').slice(0, 8)
}

export function cacheKey({ kind, dslHash, viewport, state, tolerance }: any) {
  const vp = typeof viewport === 'string' ? viewport : `${viewport?.width}x${viewport?.height}`
  return `${kind}:${dslHash}:${vp}:${state || 'default'}:t${tolerance ?? 2}`
}

export function cachePathFor(key: any, base = '.ui-reverse/cache') {
  return path.join(base, `${key}.json`)
}

export function getCached(key: any, base = '.ui-reverse/cache') {
  const p = cachePathFor(key, base)
  try {
    if (!fs.existsSync(p)) return null
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (Date.now() - new Date(raw.at).getTime() > 1000 * 60 * 60 * 24) return null // 24h 过期
    return raw.value
  } catch { return null }
}

export function setCached(key: any, value: any, base = '.ui-reverse/cache') {
  const p = cachePathFor(key, base)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), value }, null, 2))
    return p
  } catch { return null }
}

export function invalidateCache(prefix: any, base = '.ui-reverse/cache') {
  try {
    if (!fs.existsSync(base)) return 0
    let n = 0
    for (const f of fs.readdirSync(base)) {
      if (f.startsWith(prefix)) { fs.unlinkSync(path.join(base, f)); n++ }
    }
    return n
  } catch { return 0 }
}
