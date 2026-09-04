'use strict'
// reference_ingest：截图/DSL/URL → UI Truth 蓝图（core 组合管线）+ 兼容词汇 → blueprint.json
// 管线单一来源：@ui-restore/core —— lint → ingest → generateCodeBlueprint → 语义增强 → validateBlueprint
// 四闸（契约/几何/样式/Yoga 真值）任一 FAIL 直接抛错 —— 蓝图失真绝不静默落盘
// kit 词汇（regions/assets/palette/typographyProfile/…）由 blueprint-compat 投影附加（token-map 等旧消费方）

import fs from 'node:fs'
import path from 'node:path'
import {
  initTextMetrics, lintDesignExport, ingestDesignExport,
  generateCodeBlueprint, enrichSemanticSync, validateBlueprint,
} from '@ui-restore/core'
import { deriveCompatFields } from './blueprint-compat.ts'

type AnyNode = Record<string, any>

const DEFAULT_CANVAS = { width: 1440, height: 900 }

/** 拍平稿 section 归一 → ingest 形态 {x,y,dsl:{nodes,styles}}；有尺寸时合成盒子节点承载自身几何 */
function synthSectionNode(s: AnyNode, index: number): AnyNode {
  const dsl = s?.dsl && typeof s.dsl === 'object' ? s.dsl : {}
  const inner: AnyNode[] = Array.isArray(dsl.nodes) ? dsl.nodes : (Array.isArray(s?.nodes) ? s.nodes : [])
  const styles: AnyNode = dsl.styles && typeof dsl.styles === 'object' ? dsl.styles : {}
  const out: AnyNode = {
    x: Number(s?.x ?? s?.bbox?.x ?? 0),
    y: Number(s?.y ?? s?.bbox?.y ?? 0),
    dsl: { styles, nodes: inner },
  }
  const w = Number(s?.width ?? s?.bbox?.width ?? 0)
  const h = Number(s?.height ?? s?.bbox?.height ?? 0)
  // section 自身即视觉元素（bg/card 等无嵌套树）→ 合成盒子节点；单边尺寸的退化 section 不合成（防零维节点撞契约闸）
  if (w > 0 && h > 0) {
    out.dsl.nodes = [{
      id: s?.id || s?.name || `section_${index + 1}`,
      name: s?.name || s?.id || `section_${index + 1}`,
      type: s?.type || 'SECTION',
      layoutStyle: { relativeX: 0, relativeY: 0, width: w, height: h },
      ...(s?._color ? { _color: s._color } : {}),
      ...(s?.fill ? { fill: s.fill } : {}),
      children: inner,
    }]
  }
  return out
}

/** dsl 三形态归一 → ingest 可吃的 {meta:{canvas},sections:[{x,y,dsl:{nodes,styles}}]}；不支持形态返回 null */
function normalizeDslInput(dsl: any, viewport: AnyNode | null): AnyNode | null {
  const vpCanvas = viewport && Number(viewport.width) > 0 && Number(viewport.height) > 0
    ? { width: Number(viewport.width), height: Number(viewport.height) }
    : null
  // 拍平稿 sections 数组
  if (Array.isArray(dsl)) {
    return { meta: vpCanvas ? { canvas: vpCanvas } : {}, sections: dsl.map((s: AnyNode, i: number) => synthSectionNode(s, i)) }
  }
  if (!dsl || typeof dsl !== 'object') return null
  const meta: AnyNode = dsl.meta && typeof dsl.meta === 'object' ? { ...dsl.meta } : {}
  if (!meta.canvas && vpCanvas) meta.canvas = vpCanvas
  // 标准 DSL {root, meta}
  if (dsl.root) {
    return { meta, sections: [{ x: 0, y: 0, dsl: { nodes: [dsl.root], styles: dsl.styles && typeof dsl.styles === 'object' ? dsl.styles : {} } }] }
  }
  // MasterGo 原始 DSL {nodes:[...], styles}
  if (Array.isArray(dsl.nodes)) {
    return { meta, sections: [{ x: 0, y: 0, dsl: { nodes: dsl.nodes, styles: dsl.styles && typeof dsl.styles === 'object' ? dsl.styles : {} } }] }
  }
  return null
}

/** browser_dom_dump → 归一 DSL（几何减父取相对 + computed 注册字体引用表）；mock/空树抛错 */
function domDumpToNormalized(dump: AnyNode): AnyNode {
  if (dump?.mock === true) throw new Error('reference_ingest: browser_dom_dump 返回 mock 数据(mock===true)，拒绝作为参考输入')
  const roots = Array.isArray(dump?.tree) ? dump.tree : []
  const styles: AnyNode = {}
  let fontSeq = 0
  let nodeSeq = 0
  const parsePx = (v: any): number | null => {
    const n = parseFloat(String(v))
    return Number.isFinite(n) ? n : null
  }
  const visible = (n: AnyNode): boolean => {
    if (!n || n.visible === false) return false
    const r = n.rect || {}
    if (Number(r.w ?? r.width ?? 0) <= 0 || Number(r.h ?? r.height ?? 0) <= 0) return false
    return n.computed?.display !== 'none'
  }
  const conv = (n: AnyNode, parentRect: AnyNode | null): AnyNode => {
    const r = n.rect || {}
    // dump rect 为绝对坐标（kit dom-to-layout 同款减法）
    const x = Number(r.x ?? r.left ?? 0) - (parentRect ? Number(parentRect.x ?? parentRect.left ?? 0) : 0)
    const y = Number(r.y ?? r.top ?? 0) - (parentRect ? Number(parentRect.y ?? parentRect.top ?? 0) : 0)
    const w = Number(r.w ?? r.width ?? 0)
    const h = Number(r.h ?? r.height ?? 0)
    const comp = n.computed && typeof n.computed === 'object' ? n.computed : {}
    const out: AnyNode = {
      id: n.id || n.selector || `dom:${(nodeSeq += 1).toString(36)}`,
      name: n.tag || n.role || n.id || 'layer',
      type: String(n.tag || 'DIV').toUpperCase(),
      layoutStyle: { relativeX: x, relativeY: y, width: w, height: h },
    }
    // computed 字体 → styles 表注册（resolveFontRef 词表 {value:{size,weight,family,lineHeight,letterSpacing}}），文本经 text[].font 引用
    const text = typeof n.text === 'string' ? n.text : ''
    if (text) {
      const fontDef: AnyNode = {}
      const size = parsePx(comp.fontSize); if (size != null) fontDef.size = size
      const weight = parsePx(comp.fontWeight); if (weight != null) fontDef.weight = weight
      if (comp.fontFamily) fontDef.family = comp.fontFamily
      const lh = parsePx(comp.lineHeight); if (lh != null) fontDef.lineHeight = lh
      const ls = parsePx(comp.letterSpacing); if (ls != null) fontDef.letterSpacing = ls
      const ref = `__domfont_${(fontSeq += 1)}`
      styles[ref] = { value: fontDef }
      out.text = [{ text, font: ref }]
    }
    if (typeof comp.color === 'string' && comp.color) out._color = comp.color
    if (typeof comp.borderRadius === 'string') {
      const parts = String(comp.borderRadius).split(/\s+/).map((v: string) => parsePx(v)).filter((v: any): v is number => v != null)
      if (parts.length === 1) out.borderRadius = parts[0]
      else if (parts.length > 1) out.borderRadius = parts
    }
    if (comp.opacity != null && Number(comp.opacity) < 1) out.opacity = Number(comp.opacity)
    out.children = (Array.isArray(n.children) ? n.children : []).filter(visible).map((c: AnyNode) => conv(c, r))
    return out
  }
  const nodes = roots.filter(visible).map((r: AnyNode) => conv(r, null))
  if (nodes.length === 0) throw new Error('reference_ingest: DOM dump 无可见节点（页面空白或未渲染），拒绝构建蓝图')
  const vp = dump.viewport && Number(dump.viewport.width) > 0
    ? { width: Number(dump.viewport.width), height: Number(dump.viewport.height ?? 0) }
    : { ...DEFAULT_CANVAS }
  return { meta: { canvas: vp }, sections: [{ x: 0, y: 0, dsl: { nodes, styles } }] }
}

export async function referenceIngest(args: AnyNode = {}, deps: AnyNode = {}): Promise<AnyNode> {
  const { dsl, screenshotPaths, url, viewport, outPath } = args || {}
  const vp: AnyNode | null = viewport && typeof viewport === 'object' ? viewport : null
  // fail-loud：无任何可用参考输入
  if (!dsl && !url && !(Array.isArray(screenshotPaths) && screenshotPaths.length)) {
    throw new Error('reference_ingest: 缺少参考输入 — dsl / screenshotPaths / url 至少提供一项')
  }

  let normalized: AnyNode | null = null
  let source = 'screenshot'
  if (url && typeof deps?.browserDomDump === 'function') {
    const dump = await deps.browserDomDump({ selector: 'body', includeComputed: true, signal: deps.signal })
    normalized = domDumpToNormalized(dump)
    source = 'url'
  } else if (dsl) {
    normalized = normalizeDslInput(dsl, vp)
    if (!normalized) {
      throw new Error(
        'reference_ingest: 无法识别的 dsl 形态。' +
        '支持：标准 DSL {root,meta}、MasterGo 原始 DSL {nodes:[...],styles}、拍平稿 sections 数组'
      )
    }
    source = 'dsl'
  } else if (url) {
    throw new Error('reference_ingest: url 参考需要注入 deps.browserDomDump（浏览器 dump 函数）；也可改传 dsl / screenshotPaths')
  }

  // 截图-only：无结构真值可推断，产最小骨架蓝图（空树契约可过），供 verify 阶段像素对比消费
  if (!normalized) {
    const canvas = vp && Number(vp.width) > 0 && Number(vp.height) > 0
      ? { width: Number(vp.width), height: Number(vp.height) }
      : { ...DEFAULT_CANVAS }
    const bp: AnyNode = { canvas, tree: [], floatings: [], backgrounds: [] }
    const v = validateBlueprint(bp)
    const gates: AnyNode = { contract: v.ok ? 'PASS' : 'FAIL', geometry: 'SKIP', style: 'SKIP', truth: 'SKIP' }
    const compat = deriveCompatFields(bp, { source: 'screenshot', viewport: vp, gates })
    const out = outPath || '.ui-reverse/blueprint.json'
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(bp, null, 2))
    return { blueprint: bp, outPath: out, summary: { canvas: bp.canvas, regions: compat.regions.length, assets: compat.assets, gates, lintOk: true } }
  }

  // core 组合管线（镜像 pipeline.buildBlueprint，输入为内存对象故不经 readJson）
  await initTextMetrics()
  const lint = lintDesignExport(normalized, {})
  const { canvas, styles, nodes } = ingestDesignExport(normalized)
  const bp = generateCodeBlueprint({
    canvas,
    nodes,
    styles,
    scale: normalized?.meta?.scale ?? normalized?.meta?.canvas?.scale ?? null,
  })
  try { enrichSemanticSync(bp) } catch (e: any) { console.warn('[reference_ingest] 语义增强失败(已跳过):', e?.message ?? e) }
  const v = validateBlueprint(bp)

  // fail-loud：提供了结构输入却产不出树 —— 绝不静默落盘空蓝图
  if ((dsl || url) && (!Array.isArray(bp.tree) || bp.tree.length === 0)) {
    throw new Error(
      'reference_ingest: 参考输入未能解析出任何布局节点（树为空）。' +
      '检查 dsl 形态是否受支持、节点/section 是否携带尺寸几何'
    )
  }

  // 四闸守卫：契约/几何/样式/Yoga 真值任一 FAIL = 蓝图失真，拒绝落盘（仅节点存活时判定，空树四闸无对象）
  const gates: AnyNode = {
    contract: v.ok ? 'PASS' : 'FAIL',
    geometry: bp.diffReport?.verdict ?? null,
    style: bp.styleDiffReport?.verdict ?? null,
    truth: bp.truthReport?.verdict ?? null,
  }
  if (nodes.length > 0) {
    const failed = Object.entries(gates).filter(([, verdict]) => typeof verdict === 'string' && verdict.startsWith('FAIL'))
    if (failed.length) {
      throw new Error(
        `reference_ingest: 蓝图四闸未通过（${failed.map(([g, verdict]) => `${g}=${verdict}`).join(', ')}）` +
        '— 蓝图失真，拒绝落盘；请修复参考输入后重试'
      )
    }
  }

  // kit 兼容词汇投影 + 门禁/体检留痕
  const compat = deriveCompatFields(bp, { source, viewport: vp, styles, lint, gates })

  const out = outPath || '.ui-reverse/blueprint.json'
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(bp, null, 2))

  return { blueprint: bp, outPath: out, summary: { canvas: bp.canvas, regions: compat.regions.length, assets: compat.assets, gates, lintOk: lint.ok } }
}
