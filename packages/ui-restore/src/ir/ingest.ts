// ir/ingest.ts - 源适配: 多 section 设计稿 → 展平绝对坐标节点 + 合并样式表
//
// 管线契约: infer 段只消费扁平绝对坐标节点。本模块是"多 section 原始导出"
// 到该契约的标准入口(此前该逻辑在三个驱动脚本中重复)。
// 设计源适配(MasterGo/Figma/...)在 ingest 段接口化: 每源一个 normalize 函数。

import { round2 } from '../numeric.ts'

/** 防原型污染: 仅拷贝自有可枚举键, 跳过 __proto__/constructor/prototype 等危险键 */
function safeAssignStyles(target, src) {
  if (!src || typeof src !== 'object') return target
  for (const k of Object.keys(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    target[k] = src[k]
  }
  return target
}

/**
 * 展平多 section 设计导出 (flattenDesignSections)
 * 子树相对坐标逐层累加为画布绝对坐标; 合并各 section 的 dsl.styles 引用表。
 *
 * @param {object} raw { sections: [{x, y, dsl: {nodes, styles}}], meta?: {canvas} }
 * @returns {{canvas: {width,height}, styles: object, nodes: Array}}
 */
export function flattenDesignSections(raw) {
  const canvas = raw?.meta?.canvas || { width: 375, height: 812 }
  const styles = Object.create(null)
  const nodes = []
  const emit = (n, ox, oy, parentObj) => {
    if (!n || typeof n !== 'object') return
    const ls = n.layoutStyle || {}
    const x = round2((ls.relativeX ?? 0) + ox)
    const y = round2((ls.relativeY ?? 0) + oy)
    const w = ls.width ?? 0
    const h = ls.height ?? 0
    const self = {
      ...n,
      x, y, width: w, height: h,
      children: undefined,
      layoutStyle: { ...(n.layoutStyle || {}), relativeX: x, relativeY: y },
      _ax: x, _ay: y, _aw: w, _ah: h,
    }
    if (parentObj) {
      // A3 源父盒 + A5 子内容外接盒: 展平丢失父子关系, 两类几何事实随节点保留
      self._parentBox = { x: parentObj._ax, y: parentObj._ay, width: parentObj._aw, height: parentObj._ah }
      const cu = parentObj._childUnion ?? (parentObj._childUnion = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity })
      cu.x1 = Math.min(cu.x1, x); cu.y1 = Math.min(cu.y1, y)
      cu.x2 = Math.max(cu.x2, x + w); cu.y2 = Math.max(cu.y2, y + h)
    }
    nodes.push(self)
    for (const c of n.children || []) emit(c, x, y, self)
  }
  for (const s of raw?.sections || []) {
    safeAssignStyles(styles, s?.dsl?.styles)
    for (const dn of s?.dsl?.nodes || []) emit(dn, s.x ?? 0, s.y ?? 0, null)  }
  return { canvas, styles, nodes }
}

/**
 * 设计导出自适应入口 (ingestDesignExport): 兼容多种来源形态, 统一走 flattenDesignSections。
 * 解决"LLM 从 MasterGo MCP 拿到的数据形状各异, 还要手工改造成输入格式"的断点。
 *
 * 兼容形态:
 *   A {meta:{canvas}, sections:[{x,y,dsl:{nodes,styles}}]}   标准导出(驱动脚本/CLI)
 *   B {sections:[{x,y,nodes,styles}]}                        MCP getDesignSections 聚合(dsl 平铺在外层)
 *   C [{x,y,bbox?,dsl|nodes|styles,...}]                     裸 section 数组
 * canvas 缺省时按节点外接盒推断(右下最大值), 兜底 375x812。
 *
 * @param {object|Array} input 任一上述形态
 * @returns {{canvas:{width,height}, styles:object, nodes:Array}} 与 flattenDesignSections 同形
 */
export function ingestDesignExport(input) {
  const obj = Array.isArray(input) ? { sections: input } : (input || {})
  const rawSecs = Array.isArray(obj.sections) ? obj.sections : []
  const norm = []
  for (const s of rawSecs) {
    if (!s || typeof s !== 'object') continue
    // dsl 显式携带 / dsl 平铺在外层(nodes+styles 直接挂在 section 上)两种都收
    const hasOuter = Array.isArray(s.nodes) || (s.styles && typeof s.styles === 'object')
    const dsl = s.dsl && (Array.isArray(s.dsl.nodes) || s.dsl.styles) ? s.dsl : hasOuter ? { nodes: s.nodes || [], styles: s.styles || {} } : null
    if (!dsl) continue
    const bb = s.bbox || {}
    norm.push({
      id: s.id,
      name: s.name,
      x: s.x ?? bb.x ?? 0,
      y: s.y ?? bb.y ?? 0,
      width: s.width ?? bb.width ?? 0,
      height: s.height ?? bb.height ?? 0,
      dsl: { nodes: dsl.nodes || [], styles: dsl.styles || {} },
    })
  }
  const metaCanvas = obj.meta?.canvas
  const flat = flattenDesignSections({ meta: { canvas: metaCanvas || { width: 0, height: 0 } }, sections: norm })
  if (!metaCanvas) {
    // 推断画布: section 声明盒与节点外接盒取并集右下极值
    let w = 0, h = 0
    for (const s of norm) {
      if (s.width > 0) w = Math.max(w, s.x + s.width)
      if (s.height > 0) h = Math.max(h, s.y + s.height)
    }
    for (const n of flat.nodes) {
      w = Math.max(w, n.x + n.width)
      h = Math.max(h, n.y + n.height)
    }
    flat.canvas = { width: Math.round(w) || 375, height: Math.round(h) || 812 }
  }
  return flat
}

const LINT_MACHINE_NAME_RE = /(编组|矩形|椭圆|蒙版|路径|组 \d)|^(frame|vector|rect|group|mask|layer)[\s_#\-]*\d+/i

/**
 * 输入体检 (lintDesignExport): 取数段防呆 —— 进管线前发现输入污染与缺失。
 * 检查项:
 *  - duplicate-ids     重复节点 id(破坏逐 id 门禁配对)                    → FAIL
 *  - sections-count    实际 section 数 vs 预期(opts.expectSections)       → FAIL 不符
 *  - missing-font-refs text[].font 引用不在 styles 表(字号将静默丢失)     → WARN + 样本
 *  - canvas-vs-content 内容外接盒越出画布 >8px / 覆盖率过低               → WARN(疑似漏 section/裁切)
 *  - off-canvas        越出画布边缘(>8px)的节点统计                       → INFO
 *  - machine-names     机器命名占比(产物名字噪声预警)                     → INFO
 *
 * @param {object|Array} input 设计稿导出(同 ingestDesignExport 形态)
 * @param {object} [opts] expectSections: 预期 section 数(MCP 枚举时已知)
 * @returns {{ok:boolean, checks:Array<{level:'PASS'|'WARN'|'FAIL'|'INFO', check:string, detail:string}>}}
 */
export function lintDesignExport(input, opts = {}) {
  const rawSections = Array.isArray(input) ? input : (input?.sections || [])
  const flat = ingestDesignExport(input)
  const checks = []
  const push = (level, check, detail) => checks.push({ level, check, detail })

  // 1. 重复 id —— 直接破坏几何/样式守恒门禁的逐 id 配对
  const idCount = new Map()
  for (const n of flat.nodes) idCount.set(n.id, (idCount.get(n.id) || 0) + 1)
  const dups = [...idCount.entries()].filter(([, c]) => c > 1)
  push(dups.length ? 'FAIL' : 'PASS', 'duplicate-ids', dups.length ? `重复 id ${dups.length} 个: ${dups.slice(0, 5).map(([id]) => id).join(', ')}` : `${flat.nodes.length} 个节点 id 唯一`)

  // 2. section 计数 vs 预期(MCP 枚举给出的 totalCount)
  if (opts.expectSections != null) {
    const ok = rawSections.length === Number(opts.expectSections)
    push(ok ? 'PASS' : 'FAIL', 'sections-count', ok ? `${rawSections.length} 个 section 与预期一致` : `实际 ${rawSections.length} ≠ 预期 ${opts.expectSections}(疑似分页拉取遗漏)`)
  }

  // 3. 字体引用完整性 —— 引用断裂时字号静默丢失, 是最隐蔽的输入污染
  let refs = 0
  const missing = []
  for (const n of flat.nodes) {
    if (!Array.isArray(n.text)) continue
    for (const t of n.text) {
      if (!t || !t.font) continue
      refs++
      if (!(flat.styles && typeof flat.styles === 'object' && flat.styles[t.font])) missing.push({ id: n.id, ref: t.font })
    }
  }
  push(missing.length ? 'WARN' : 'PASS', 'missing-font-refs', missing.length ? `${missing.length}/${refs} 处字体引用不在 styles 表(字号将缺失), 样本: ${missing.slice(0, 3).map((m) => `${m.id}→${m.ref}`).join(', ')}` : `${refs} 处字体引用全部可解析`)

  // 4. 内容外接盒 vs 画布 —— 越界提示漏拉/裁切, 覆盖率过低提示可能拿错页面
  const cw = flat.canvas?.width || 0
  const ch = flat.canvas?.height || 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let offCanvas = 0
  for (const n of flat.nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height)
    if (n.x < -8 || n.y < -8 || n.x + n.width > cw + 8 || n.y + n.height > ch + 8) offCanvas++
  }
  if (flat.nodes.length) {
    const over = maxX > cw + 8 || maxY > ch + 8 || minX < -8 || minY < -8
    push(over ? 'WARN' : 'PASS', 'canvas-vs-content', over
      ? `内容外接盒(${Math.round(minX)},${Math.round(minY)})~(${Math.round(maxX)},${Math.round(maxY)}) 越出画布 ${cw}x${ch}, 疑似元素被裁切或漏拉相邻 section`
      : `内容外接盒在画布 ${cw}x${ch} 内`)
    const coverX = (maxX - minX) / cw, coverY = (maxY - minY) / ch
    if (coverX < 0.5 && coverY < 0.5) push('WARN', 'content-coverage', `内容仅覆盖画布 ${Math.round(coverX * 100)}%x${Math.round(coverY * 100)}%, 疑似拿错画板或漏拉主体 section`)
  }

  // 5. 统计信息
  push(offCanvas ? 'INFO' : 'PASS', 'off-canvas', offCanvas ? `${offCanvas} 个节点越出画布边缘(将按 off-canvas 语义保留)` : '无越界节点')
  const machineNamed = flat.nodes.filter((n) => LINT_MACHINE_NAME_RE.test(String(n.name || ''))).length
  push('INFO', 'machine-names', machineNamed ? `${machineNamed}/${flat.nodes.length} 个机器命名(管线将合成语义名)` : '无机器命名')

  return { ok: checks.every((c) => c.level !== 'FAIL'), checks }
}
