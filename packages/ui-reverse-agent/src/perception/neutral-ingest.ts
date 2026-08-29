'use strict'
// neutral-ingest：中立树（doc15 tree.json）→ blueprint.json
// 输入：neutralTree（render-dsl.mjs 输出）或 neutralTree 文件路径
// 输出：blueprint（与 reference_ingest 同构），落盘 .ui-reverse/blueprint.json
// 关键：复用 doc14/15 的已验证细节（TEXT fill=文字色、lineHeight 单位、stroke inset 等），中立树已是正确结果，此处仅做形态转换，不重新推导

import fs from 'node:fs'
import path from 'node:path'
import { buildBlueprint } from '@3kaiu/dsh-plugin-kit'

function isNeutralTree(obj) {
  return obj && typeof obj === 'object' && (obj.root || obj.meta) && obj.format === 'neutral-render-tree-v1' || (obj.root && obj.root.kind === 'page')
}

function neutralNodeToBlueprintNode(n) {
  // n 来自 doc15 §6：{kind, x,y,width,height, flex, bg, radius, shadows, blur, opacity, rotate, children} 等
  const kind = n.kind
  const base: Record<string, any> = {
    id: n.id || `n-${Math.random().toString(36).slice(2,7)}`,
    name: n.name || kind,
    type: kind === 'text' ? 'TEXT' : kind === 'icon' ? 'PATH' : kind === 'image' ? 'LAYER' : kind === 'component' ? 'FRAME' : 'FRAME',
    role: n.role || kind,
    // 统一 bbox：中立树用 x/y/width/height 数值
    rect: { x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? 0, h: n.height ?? 0 },
    bbox: { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 },
    layoutStyle: { width: n.width, height: n.height, relativeX: n.x, relativeY: n.y, rotate: n.rotate },
    // 保留中立树的已结构化字段供 blueprint 后续提取（typography/palette）
    _neutral: n,
  }
  if (kind === 'text') {
    base.text = n.text || ''
    base.font = {
      family: n.font?.family || null,
      size: n.font?.size || null,
      weight: n.font?.weight || null,
      lineHeight: n.font?.lineHeight || null,
      letterSpacing: n.font?.letterSpacing || null,
    }
    base._color = n.color || n.gradient || null // doc14：TEXT fill 是文字色，已在中立树转为 color
    base.textColor = n.color || null
    base.computed = {
      fontFamily: n.font?.family || null,
      fontSize: n.font?.size || null,
      fontWeight: n.font?.weight || null,
      lineHeight: n.font?.lineHeight || null,
      letterSpacing: n.font?.letterSpacing || null,
      color: n.color || null,
    }
    if (n.stroke) base.stroke = n.stroke
    if (n.shadows) base.effect = n.shadows
  }
  if (kind === 'container' || kind === 'shape') {
    base.bg = n.bg || null
    base.fill = typeof n.bg === 'string' ? n.bg : null
    base._color = typeof n.bg === 'string' ? n.bg : null
    if (n.radius != null) base.borderRadius = n.radius
    if (n.shadows) base.effect = n.shadows
    if (n.flex) base.flexContainerInfo = n.flex
  }
  if (kind === 'icon') {
    base.svgShortKey = n.svg ? 'neutral-svg' : null
    base._neutralSvg = n.svg || null
    base.bitmap = n.bitmap || false
  }
  if (kind === 'image') {
    base.tag = 'img'
    base.fill = n.url ? `url(${n.url})` : (n.svg || '')
    base.src = n.url || n.svg || ''
  }
  if (kind === 'component') {
    base.component = n.template || null
    base.instances = n.instances || []
  }
  if (Array.isArray(n.children) && n.children.length) {
    base.children = n.children.map(neutralNodeToBlueprintNode)
  } else {
    base.children = []
  }
  return base
}

function neutralTreeToBlueprintTree(neutral) {
  const root = neutral.root || neutral
  const kids = root.children || []
  return kids.map(neutralNodeToBlueprintNode)
}

export function neutralToBlueprint(neutral) {
  const tree = neutralTreeToBlueprintTree(neutral)
  const canvas = neutral.meta?.canvas || neutral.root?.canvas || { width: neutral.root?.width || 1440, height: neutral.root?.height || 900, background: neutral.root?.background || '#fff' }
  // 诊断：doc14/15 的 diagnostics 直接并入 blueprint.meta
  const diagnostics = neutral.meta?.diagnostics || {}
  const blueprint = buildBlueprint({ canvas, tree, styles: {}, dsl: null })
  // 用中立树的 canvas 背景覆盖
  if (canvas.background) blueprint.canvas.background = canvas.background
  blueprint.meta.source = 'neutral-tree'
  blueprint.meta.neutralFormat = neutral.format || 'neutral-render-tree-v1'
  blueprint.meta.diagnostics = diagnostics
  // 中立树已含精确排版/调色板，补充 blueprint 的提取结果（以中立树为准，blueprint 的提取为兜底）
  return blueprint
}

export async function neutralIngest({ neutralTree, neutralPath, outPath }: Record<string, any> = {}) {
  let neutral = neutralTree
  if (!neutral && neutralPath) {
    try { neutral = JSON.parse(fs.readFileSync(neutralPath, 'utf8')) } catch (e) { throw new Error(`读取中立树失败 ${neutralPath}: ${e.message}`) }
  }
  if (!neutral) throw new Error('neutralIngest 需 neutralTree 或 neutralPath')
  if (!isNeutralTree(neutral)) {
    // 兼容：传入的是 {meta, root} 但无 format 标记，仍尝试
    if (!neutral.root && !neutral.meta) throw new Error('非中立树格式，需 {meta, root} 或 {format:"neutral-render-tree-v1"}')
  }
  const blueprint = neutralToBlueprint(neutral)
  const out = outPath || '.ui-reverse/blueprint.json'
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(blueprint, null, 2))
  } catch {}
  return { blueprint, outPath: out, summary: { canvas: blueprint.canvas, regions: blueprint.regions.length, assets: blueprint.assets } }
}
