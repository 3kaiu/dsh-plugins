'use strict'
// neutral-ingest：中立树（doc15 tree.json）→ blueprint.json（core 组合管线）
// 管线单一来源：@ui-restore/core —— initTextMetrics → lint → ingest → generateCodeBlueprint → 语义增强 → validateBlueprint
// 四闸（契约/几何/样式/Yoga 真值）任一 FAIL 直接抛错 —— 蓝图失真绝不静默落盘
// 关键：中立树已是设计稿测量事实，本模块只做形态转换（neutral 词汇 → core ingest 词汇），
// 不重新推导、不取整；flex 由引擎从几何自动反推（flexContainerInfo 无需透传）。
// kit 兼容词汇（regions/assets/palette/typographyProfile/…）由 blueprint-compat 投影附加。

import fs from 'node:fs'
import path from 'node:path'
import {
  initTextMetrics, lintDesignExport, ingestDesignExport,
  generateCodeBlueprint, enrichSemanticSync, validateBlueprint,
} from '@ui-restore/core'
import { deriveCompatFields } from './blueprint-compat.ts'

type AnyNode = Record<string, any>

function isNeutralTree(obj: any) {
  return obj && typeof obj === 'object' && ((obj.root || obj.meta) && obj.format === 'neutral-render-tree-v1' || (obj.root && obj.root.kind === 'page'))
}

/** 中立阴影 → 引擎 effects 词汇（extractExactStyles 消费 offset{x,y}/radius/spread/color） */
function toEffects(shadows: any): AnyNode[] | undefined {
  if (!Array.isArray(shadows) || shadows.length === 0) return undefined
  const effects = shadows.filter(Boolean).map((s: AnyNode) => ({
    type: s.type || 'DROP_SHADOW',
    offset: { x: Number(s.offsetX ?? s.offset?.x ?? 0), y: Number(s.offsetY ?? s.offset?.y ?? 0) },
    radius: Number(s.radius ?? s.blur ?? 0),
    ...(s.spread != null ? { spread: Number(s.spread) } : {}),
    color: s.color || 'rgba(0,0,0,0.1)',
  }))
  return effects.length ? effects : undefined
}

/** 中立描边 → 引擎平铺词汇（strokeWidth/strokeColor/strokeAlign/strokeType） */
function toStrokeFields(stroke: any): AnyNode {
  if (!stroke || typeof stroke !== 'object') return {}
  return {
    ...(stroke.width != null ? { strokeWidth: Number(stroke.width) } : {}),
    ...(stroke.color != null ? { strokeColor: String(stroke.color) } : {}),
    ...(stroke.align != null ? { strokeAlign: String(stroke.align) } : {}),
    ...(stroke.style != null ? { strokeType: String(stroke.style) } : {}),
  }
}

/**
 * 中立树节点 → core ingest 词汇（递归，子坐标按父相对语义展平累加）。
 * text → runs + styles 表注册（__neutralfont_N）；container/shape bg → _color；
 * icon svg → svgShortKey 注册 + svgMap（蓝图生成后按 id 回挂 svg 本体）；
 * image url → fill:url(...)；radius/shadows/stroke/opacity/rotate 直传（设计事实）。
 */
function neutralNodeToIngestNode(n: AnyNode, styles: AnyNode, svgMap: Map<string, string>, state: { nodeSeq: number; fontSeq: number }): AnyNode {
  const kind = String(n?.kind || 'container')
  const id = n.id || `neutral_${(state.nodeSeq += 1).toString(36)}`
  const base: AnyNode = {
    id,
    name: n.name || kind,
    type: kind === 'text' ? 'TEXT' : kind === 'icon' ? 'PATH' : kind === 'image' ? 'IMAGE' : 'FRAME',
    layoutStyle: {
      relativeX: Number(n.x ?? 0),
      relativeY: Number(n.y ?? 0),
      width: Number(n.width ?? 0),
      height: Number(n.height ?? 0),
      ...(n.rotate != null ? { rotate: Number(n.rotate) } : {}),
    },
  }
  if (kind === 'text') {
    const font = n.font && typeof n.font === 'object' ? n.font : {}
    const fontDef: AnyNode = {}
    if (font.family != null) fontDef.family = font.family
    if (font.size != null) fontDef.size = Number(font.size)
    if (font.weight != null) fontDef.weight = Number(font.weight)
    if (font.lineHeight != null) fontDef.lineHeight = Number(font.lineHeight)
    if (font.letterSpacing != null) fontDef.letterSpacing = Number(font.letterSpacing)
    const ref = `__neutralfont_${(state.fontSeq += 1)}`
    styles[ref] = { value: fontDef }
    base.text = [{ text: String(n.text ?? ''), font: ref }]
    // doc14：TEXT 填充即文字色；gradient 文字色同通道透传
    const color = n.color ?? n.gradient
    if (typeof color === 'string' && color) base._color = color
  } else if (kind === 'container' || kind === 'shape') {
    if (typeof n.bg === 'string' && n.bg) base._color = n.bg
    if (n.radius != null) base.borderRadius = n.radius
  } else if (kind === 'icon') {
    if (typeof n.svg === 'string' && n.svg) {
      base.svgShortKey = 'neutral-svg'
      svgMap.set(id, n.svg)
    }
  } else if (kind === 'image') {
    const src = n.url || n.svg
    if (typeof src === 'string' && src) base.fill = /^url\(/i.test(src) ? src : `url(${src})`
  }
  const effects = toEffects(n.shadows)
  if (effects) base.effects = effects
  Object.assign(base, toStrokeFields(n.stroke))
  if (n.opacity != null && Number(n.opacity) < 1) base.opacity = Number(n.opacity)
  base.children = (Array.isArray(n.children) ? n.children : []).map((c: AnyNode) => neutralNodeToIngestNode(c, styles, svgMap, state))
  return base
}

/** 中立树 → core ingest 形态 {meta:{canvas}, sections:[{x:0,y:0,dsl:{nodes,styles}}], svgMap} */
function neutralToIngestExport(neutral: AnyNode) {
  const root = neutral.root || neutral
  const styles: AnyNode = {}
  const svgMap = new Map<string, string>()
  const state = { nodeSeq: 0, fontSeq: 0 }
  const nodes = (Array.isArray(root.children) ? root.children : []).map((c: AnyNode) => neutralNodeToIngestNode(c, styles, svgMap, state))
  const canvas = neutral.meta?.canvas || { width: root.width || 1440, height: root.height || 900 }
  return {
    meta: { canvas: { width: Number(canvas.width) || 1440, height: Number(canvas.height) || 900 } },
    sections: [{ x: 0, y: 0, dsl: { nodes, styles } }],
    svgMap,
  }
}

/** svgMap 回挂：引擎节点白名单不含 svg 本体，蓝图生成后按 id 补挂（deriveAssets 消费 n.svg） */
function attachSvg(nodes: any, svgMap: Map<string, string>) {
  if (!Array.isArray(nodes)) return
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const svg = svgMap.get(n.id)
    if (svg) n.svg = svg
    attachSvg(n.children, svgMap)
  }
}

/** 中立树 → blueprint（core 组合管线 + kit 兼容词汇投影），返回 {bp, compat} 内部形态 */
async function buildNeutralBlueprint(neutral: AnyNode): Promise<{ bp: AnyNode; compat: AnyNode }> {
  if (!neutral || typeof neutral !== 'object') throw new Error('neutralToBlueprint 需中立树对象 {meta, root}')
  const { meta, sections, svgMap } = neutralToIngestExport(neutral)
  await initTextMetrics()
  const lint = lintDesignExport({ meta, sections }, {})
  const { canvas, styles, nodes } = ingestDesignExport({ meta, sections })
  if (nodes.length === 0) throw new Error('neutralToBlueprint: 中立树无可转换节点（root.children 为空）')
  const bp = generateCodeBlueprint({ canvas, nodes, styles, scale: null })
  try { enrichSemanticSync(bp) } catch (e: any) { console.warn('[neutral_ingest] 语义增强失败(已跳过):', e?.message ?? e) }
  attachSvg(bp.tree, svgMap)
  attachSvg(bp.floatings, svgMap)
  const v = validateBlueprint(bp)

  // 四闸守卫：任一 FAIL = 蓝图失真，拒绝产出（fail-loud，与 reference_ingest 同规）
  const gates: AnyNode = {
    contract: v.ok ? 'PASS' : 'FAIL',
    geometry: bp.diffReport?.verdict ?? null,
    style: bp.styleDiffReport?.verdict ?? null,
    truth: bp.truthReport?.verdict ?? null,
  }
  const failed = Object.entries(gates).filter(([, verdict]) => typeof verdict === 'string' && verdict.startsWith('FAIL'))
  if (failed.length) {
    throw new Error(
      `neutral_ingest: 蓝图四闸未通过（${failed.map(([g, verdict]) => `${g}=${verdict}`).join(', ')}）` +
      '— 蓝图失真，拒绝落盘；请检查中立树数据'
    )
  }

  // 画布底色：generateCodeBlueprint 的 canvas 仅 {width,height}，中立树背景在此回挂
  const neutralCanvas = neutral.meta?.canvas || neutral.root || {}
  if (typeof neutralCanvas.background === 'string' && neutralCanvas.background) bp.canvas.background = neutralCanvas.background
  const compat = deriveCompatFields(bp, { source: 'neutral-tree', styles, lint, gates, metaExtras: { neutralFormat: neutral.format || 'neutral-render-tree-v1', diagnostics: neutral.meta?.diagnostics || {} } })
  return { bp, compat }
}

/** 中立树 → blueprint 本体（仅 bp，不含 compat 投影） */
export async function neutralToBlueprint(neutral: AnyNode): Promise<AnyNode> {
  return (await buildNeutralBlueprint(neutral)).bp
}

export async function neutralIngest({ neutralTree, neutralPath, outPath }: AnyNode = {}) {
  let neutral = neutralTree
  if (!neutral && neutralPath) {
    try { neutral = JSON.parse(fs.readFileSync(neutralPath, 'utf8')) } catch (e: any) { throw new Error(`读取中立树失败 ${neutralPath}: ${e?.message ?? e}`) }
  }
  if (!neutral) throw new Error('neutralIngest 需 neutralTree 或 neutralPath')
  if (!isNeutralTree(neutral)) {
    // 兼容：传入的是 {meta, root} 但无 format 标记，仍尝试
    if (!neutral.root && !neutral.meta) throw new Error('非中立树格式，需 {meta, root} 或 {format:"neutral-render-tree-v1"}')
  }
  const { bp: blueprint, compat } = await buildNeutralBlueprint(neutral)
  const out = outPath || '.ui-reverse/blueprint.json'
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(blueprint, null, 2))
  return { blueprint, outPath: out, summary: { canvas: blueprint.canvas, regions: compat.regions.length, assets: compat.assets, gates: (blueprint.meta as AnyNode)?.gates } }
}
