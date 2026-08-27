// target/asset-resolver.ts — P0-3 Asset Contract + Resolver(资产生命周期闭环)
//
// 生命周期十环(v4 §4): identity / extraction / storage / path / format /
// transformation / crop / scaling / dedup / reference —— 每个资产解析结果都带全链路溯源。
//
// 铁律(承 SKILL §④/assets 契约):
//   - svgKey 经导出表解析(mcp_extractSvg 回填), **不得用近似图形替代**; 解析失败 = missing,
//     emit 侧只能按 bounds 几何占位并计入 contract 违约(由 gate 判)。
//   - image + crop=cover + visibleRect → background-image/size/position 一致性映射在此定死,
//     emit 不再自行发挥。
//   - dedup: 同 svgKey 多实例只落一份文件(轮播三卡 28→去重后一份 key 一文件)。
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeSvg } from './svg-sanitize'

/**
 * 回填 assets.json(B0): 把 mcp_extractSvg / 设计侧位图导出的结果合并进产物包 assets 表。
 * @param {string} assetsJsonPath 产物包 *.assets.json 路径
 * @param {object} exported {svgs:[{id,svg}], images:[{id,src}]}  —— id 为 svgKey 或 nodeId
 * @returns {{vectors: number, images: number}} 回填计数
 */
export function backfillAssets(assetsJsonPath, exported) {
  const table = JSON.parse(fs.readFileSync(assetsJsonPath, 'utf8'))
  let vectors = 0, images = 0
  for (const s of exported.svgs || []) {
    for (const v of table.vectors || []) {
      const key = v.svgKey || v.id
      if (key === s.id || v.id === s.id) { v.svg = s.svg; vectors++; break }
    }
  }
  for (const im of exported.images || []) {
    for (const v of table.images || []) {
      if (v.id === im.id) { v.src = im.src; images++; break }
    }
  }
  fs.writeFileSync(assetsJsonPath, JSON.stringify(table, null, 1))
  return { vectors, images }
}

/** 从回填后的 assets 表建索引: svgKey/nodeId → {svg|src} */
function indexAssets(assetsExport) {
  const svg = new Map(), image = new Map()
  for (const v of assetsExport?.vectors || []) {
    const key = v.svgKey || v.id
    if (key && (v.svg || v.path)) svg.set(key, v)
  }
  for (const v of assetsExport?.images || []) {
    if (v.id && (v.src || v.path)) image.set(v.id, v)
  }
  return { svg, image }
}

/**
 * 资产解析主入口: plan.unresolvedAssets(含 image) + assets 表 → 逐资产解析 + 落盘计划。
 * @param {object} bp 蓝图(image 节点的 crop/transform 从这里读)
 * @param {object} plan planGeneration 输出(unresolvedAssets)
 * @param {object} opts {assetsExport: 回填后的 assets.json 对象或路径, assetDir: 项目内目标目录,
 *                       projectDir: 落盘根(缺省只产 storage 计划不写盘)}
 * @returns {{assets, storage, summary}}
 */
export function resolveAssets(bp, plan, opts = {}) {
  const table = typeof opts.assetsExport === 'string'
    ? JSON.parse(fs.readFileSync(opts.assetsExport, 'utf8'))
    : opts.assetsExport
  const idx = indexAssets(table)
  const assetDir = opts.assetDir || 'src/assets'
  const assets = []
  const storage = []
  const fileByKey = new Map()
  let deduped = 0

  // image 节点(带 crop/transform 的位图): identity= node.fill.src ?? nodeId
  const imageNodes = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.fill?.type === 'image') imageNodes.push(n)
    for (const c of n.children || []) walk(c)
  }
  for (const r of [...(bp?.tree || []), ...(bp?.floatings || [])]) walk(r)

  for (const node of imageNodes) {
    const hit = idx.image.get(node.id) || (node.fill.src ? { src: node.fill.src } : null)
    const ext = hit?.src && /^data:/.test(hit.src) ? (/.png/.test(hit.src.slice(0, 40)) ? 'png' : 'jpeg') : safeExt((hit?.src || '').split('.').pop()?.split('?')[0] || 'png')
    const file = `${assetDir}/${sanitize(node.id)}.${ext}`
    const crop = node.fill.crop ? { mode: 'cover', visibleRect: node.fill.crop.visibleRect } : null
    assets.push({
      id: node.id, kind: 'image', key: node.fill.src || node.id,
      status: hit ? 'resolved' : 'missing',
      file: hit ? file : undefined,
      source: hit?.src ? ('外部/导出') : undefined,
      format: ext,
      crop, // crop/scale 映射: emit 用 background-size:cover + background-position 按 visibleRect 归一
      reference: crop ? 'background' : 'img',
      note: hit ? undefined : '位图无导出源: 按 bounds 占位并计入违约, 禁止近似替代',
    })
    if (hit && !fileByKey.has(file)) {
      fileByKey.set(file, true)
      storage.push({ file, kind: 'image', write: hit.src ? { kind: 'data', value: hit.src } : { kind: 'copy', from: hit.path || hit.src } })
    }
  }

  for (const ua of plan.unresolvedAssets.filter((a) => a.kind === 'svg')) {
    const hit = idx.svg.get(ua.key)
    if (ua.key && fileByKey.has(`svg:${ua.key}`)) {
      deduped++
      const prev = assets.find((a) => a.kind === 'svg' && a.key === ua.key)
      if (prev) assets.push({ id: ua.nodeId, kind: 'svg', key: ua.key, status: 'resolved', file: prev.file, dedupOf: prev.id, reference: prev.reference, rawSvg: (prev as any).rawSvg || (prev as any).svg, svg: (prev as any).svg || (prev as any).rawSvg })
      continue
    }
    if (!hit) {
      assets.push({ id: ua.nodeId, kind: 'svg', key: ua.key, status: 'missing', note: 'svgKey 无导出源: 按 bounds 几何占位并计入违约, 禁止近似替代' })
      continue
    }
    const file = `${assetDir}/${sanitize(ua.key)}.svg`
    const svgContent = hit.svg || (hit as any).rawSvg || ''
    assets.push({ id: ua.nodeId, kind: 'svg', key: ua.key, status: 'resolved', file, source: 'mcp_extractSvg', format: 'svg', reference: 'inline', rawSvg: svgContent, svg: svgContent })
    fileByKey.set(`svg:${ua.key}`, true)
    storage.push({ file, kind: 'svg', write: { kind: 'content', value: svgContent }, copyFrom: hit.path })
  }

  // 落盘(显式传 projectDir 才写; 否则只返回计划供调用方审查)
  if (opts.projectDir) {
    const root = path.resolve(opts.projectDir)
    for (const s of storage) {
      const abs = confine(root, s.file)
      if (!abs) continue // 路径越界（含 .. / 绝对路径）→ 拒绝落盘
      // copyFrom 同样必须落在 projectDir 内，禁止任意文件读取
      const copyFrom = s.copyFrom ? confine(root, s.copyFrom) : null
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (s.write?.kind === 'content') fs.writeFileSync(abs, sanitizeSvg(s.write.value))
      else if (s.write?.kind === 'data' && /^data:/.test(s.write.value)) {
        const b64 = s.write.value.split(',')[1] || ''
        fs.writeFileSync(abs, Buffer.from(b64, 'base64'))
      } else if (copyFrom && fs.existsSync(copyFrom)) fs.copyFileSync(copyFrom, abs)
    }
  }

  const resolved = assets.filter((a) => a.status === 'resolved').length
  return {
    assets,
    storage,
    summary: {
      total: assets.length,
      resolved,
      missing: assets.length - resolved,
      deduped,
      note: `missing 仅允许几何占位并计入 gate 违约(${assets.filter((a) => a.status === 'missing').length} 处)`,
    },
  }
}

/** image+crop → CSS background 三件套(emit 与验证共用同一映射, 防两处实现漂移) */
export function imageBackgroundStyle(fill, bounds) {
  if (!fill || fill.type !== 'image') return null
  const src = fill.src || 'MISSING_ASSET'
  if (!fill.crop) return { backgroundImage: `url(${src})`, backgroundSize: '100% 100%', backgroundPosition: '0 0' }
  const vr = fill.crop.visibleRect
  // cover + position: visibleRect 中心相对素材的比例 → background-position 百分比
  const px = vr.width > 0 ? ((vr.x + vr.width / 2) / bounds.width) * 100 : 50
  const py = vr.height > 0 ? ((vr.y + vr.height / 2) / bounds.height) * 100 : 50
  return {
    backgroundImage: `url(${src})`,
    backgroundSize: 'cover',
    backgroundPosition: `${round2(clamp(px, 0, 100))}% ${round2(clamp(py, 0, 100))}%`,
  }
}

const sanitize = (s) => String(s || 'asset').replace(/[^a-zA-Z0-9_-]+/g, '_')
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const round2 = (n) => Math.round(n * 100) / 100

/**
 * 路径收敛：将 file 解析到 root 之下，若含 `..`/绝对路径导致越界则返回 null（拒绝落盘/读取）。
 * 用于防止 assetDir/copyFrom/ext 中注入 `..` 造成的任意文件读写。
 */
function confine(root: string, file: string): string | null {
  const abs = path.resolve(root, file)
  const rel = path.relative(root, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

/** 仅允许已知安全扩展名，避免 ext 注入造成的非预期落盘类型 */
function safeExt(ext: string): string {
  const e = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e) ? e : 'png'
}
