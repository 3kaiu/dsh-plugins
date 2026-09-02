// scale.ts - 设计稿画布倍率(design scale)检测与归一化
//
// 问题: MasterGo 画板可能是 @1x/@2x/@3x 导出(750 宽 = 375 逻辑 × 2)。
//       管线全部容差(TOL=2px、带聚类 gap≤12、胶囊几何区间)按 @1x 标定,
//       倍率稿直进管线会让推断失准、产物数值翻倍。
//
// 方案(三件套, 全部技术栈中立):
//   detectDesignScale  双证据启发式检测 —— 设备逻辑宽比值 × 正文字号簇交叉验证。
//                      单一信号不可靠: 750 既可能是 @2x 手机也可能是 @1x 平板,
//                      但正文字号有强行业约定(逻辑 10~17px), 两证据一致才高置信。
//   applyDesignScale   确定性归一器: 坐标/尺寸/字号/行高/字距同乘因子(styles 表一并处理)。
//   元数据溯源          蓝图 canvas.scale = {factor, source: declared|inferred|explicit,
//                      confidence?} —— 只记事实, 不改字段语义; 未归一时不输出该字段。

import { round2 } from './numeric.ts'
/** 长度字段缩放器(绑定因子; 非数值如 "auto" 原样透传) */
const dimBy = (f: any) => (v) => (typeof v === 'number' && isFinite(v) ? round2(v * f) : v)

/** 长度/数组长度缩放(radius 等单值或四角数组) */
function scaleLength(v, dim) {
  if (Array.isArray(v)) return v.map((x: any) => dim(x))
  return dim(v)
}
/** padding/margin 对象(数字或 {top,right,bottom,left})缩放 */
function scaleBox(p, dim) {
  if (typeof p === 'number') return dim(p)
  if (p && typeof p === 'object') {
    const o = {}
    for (const k of ['top', 'right', 'bottom', 'left', 'horizontal', 'vertical', 'all']) {
      if (p[k] != null) o[k] = dim(p[k])
    }
    return o
  }
  return p
}
/** 描边缩放(宽度/虚线) */
function scaleStroke(s, dim) {
  if (!s || typeof s !== 'object') return s
  const o = { ...s }
  for (const k of ['width', 'dashWidth', 'dashGap']) if (o[k] != null) o[k] = dim(o[k])
  return o
}
/** 阴影/模糊效果缩放(offsetX/Y/blur/spread/radius) */
function scaleEffect(e, dim) {
  if (!e || typeof e !== 'object') return e
  const o = { ...e }
  for (const k of ['offsetX', 'offsetY', 'blur', 'spread', 'radius']) if (o[k] != null) o[k] = dim(o[k])
  return o
}

/** 常见设备逻辑宽(@1x); 用于比值证据（覆盖 2023-2026 主流 iPhone/Android/平板/桌面断点） */
const LOGICAL_WIDTHS = [320, 360, 375, 384, 390, 393, 402, 412, 414, 428, 430, 440, 744, 768, 800, 810, 820, 834, 1024, 1080, 1194, 1280, 1366, 1440, 1512, 1728, 1920]
/** 候选倍率 */
const SCALE_FACTORS = [1, 1.5, 2, 3, 4]
/** 正文逻辑字号带(行业约定主体区间) */
const BODY_FONT_MIN = 9
const BODY_FONT_MAX = 20

function nearestFactor(ratio) {
  return SCALE_FACTORS.reduce((a, b) => (Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a))
}

/** 收集观测字号: 内联 textStyle 优先, 其次 dsl.styles 字体引用表 */
function collectFontSizes(nodes = [], styles: Record<string, any> = {}) {
  const sizes = []
  for (const n of nodes) {
    if (!n || n.type !== 'TEXT') continue
    if (n.textStyle?.fontSize != null) { sizes.push(Number(n.textStyle.fontSize)); continue }
    const ref = Array.isArray(n.text) ? n.text.find((t: any) => t && t.font)?.font : null
    const v = ref && styles[ref] ? (styles[ref].value || styles[ref]) : null
    if (v && typeof v === 'object' && v.size != null) sizes.push(Number(v.size))
  }
  return sizes.filter((s: any) => isFinite(s) && s > 0)
}

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 设计倍率检测 (detectDesignScale)
 *
 * @param {object} input {canvas, nodes, styles} (flattenDesignSections 的返回形态即可)
 * @returns {{scale:number, confidence:number, evidence:string[], alternatives:Array}|null}
 *   scale=建议除数(原稿为 scale 倍画板); 无画布信息返回 null。
 */
export function detectDesignScale(input: Record<string, any> = {}) {
  const w = input?.canvas?.width || 0
  if (!w) return null
  const nodes = Array.isArray(input.nodes) ? input.nodes : []
  const styles = input.styles && typeof input.styles === 'object' ? input.styles : {}
  const evidence = []
  const scoreBy = new Map() // scale -> score

  // 证据 A: 画布宽 / 设备逻辑宽 ≈ 整倍率
  for (const lw of LOGICAL_WIDTHS) {
    const ratio = w / lw
    const f = nearestFactor(ratio)
    const err = Math.abs(f - ratio)
    if (err <= Math.max(0.03 * ratio, 1 / lw)) {
      const score = 0.6 * (1 - err / Math.max(ratio, 0.01))
      // 同倍率取最高分(多个逻辑宽命中时)
      scoreBy.set(f, Math.max(scoreBy.get(f) || 0, score))
      evidence.push(`画布宽 ${w} ≈ 逻辑宽 ${lw} × ${f}(误差 ${round2(err * 100) / 100})`)
    }
  }

  // 证据 B: 正文字号簇 —— 中位字号落在 [BODY_FONT_MIN*s, BODY_FONT_MAX*s] 即支持该倍率
  const sizes = collectFontSizes(nodes, styles)
  const med = median(sizes)
  if (med != null) {
    for (const f of SCALE_FACTORS) {
      const lo = BODY_FONT_MIN * f, hi = BODY_FONT_MAX * f
      if (med >= lo && med <= hi) {
        // 带内居中程度给分(越靠近带中心越可信)
        const centerBias = 1 - Math.abs(med - (lo + hi) / 2) / ((hi - lo) / 2)
        scoreBy.set(f, (scoreBy.get(f) || 0) + 0.4 * (0.5 + centerBias / 2))
        evidence.push(`中位字号 ${round2(med)}px 落在 ${f}× 正文带[${round2(lo)},${round2(hi)}](样本 ${sizes.length})`)
      }
    }
  } else {
    evidence.push('无文本节点, 仅靠画布宽度证据')
  }

  if (scoreBy.size === 0) {
    return { scale: 1, confidence: 0.3, evidence: [`画布宽 ${w} 无已知逻辑宽整倍匹配, 默认原样`], alternatives: [] }
  }

  // 排序: 分数降序, 同分取更小倍率(奥卡姆)
  const ranked = [...scoreBy.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
  const [bestScale, bestScore] = ranked[0]
  const rest = ranked.slice(1)
  // 置信度 = 对最强竞争候选的边际占比(次高分作分母基准, 弱噪声不稀释);
  // 且强制"双证据才高置信": 仅单一证据时多种倍率常可同样解释(如 750 宽), 封顶 0.55 不予自动采纳
  const usedWidth = evidence.some((e: any) => e.includes('逻辑宽'))
  const usedFont = evidence.some((e: any) => e.includes('字号'))
  const secondScore = rest[0]?.[1] || 0
  let confidence = bestScore / (bestScore + secondScore)
  if (!(usedWidth && usedFont)) confidence = Math.min(confidence, 0.55)
  return {
    scale: bestScale,
    confidence: round2(Math.min(1, confidence)),
    evidence,
    alternatives: rest.map(([scale, score]) => ({ scale, score: round2(score) })),
  }
}

/**
 * 倍率归一器 (applyDesignScale): 所有长度语义字段同乘 factor(纯函数, 不改输入)。
 * factor = 1/designScale, 如 @2x 稿传 0.5。
 * 覆盖: layoutStyle 相对坐标与尺寸 / 兼容顶层 x/y/w/h / 内联 textStyle /
 * dsl.styles 字体表(size/lineHeight/letterSpacing)。旋转是角度, 不缩放。
 *
 * @returns {{nodes:Array, styles:object}}
 */
export function applyDesignScale(nodes = [], styles: Record<string, any> = {}, factor = 1) {
  if (!isFinite(factor) || factor <= 0 || factor === 1) return { nodes, styles }
  const dim = dimBy(factor)
  const walkNode = (n: any) => {
    if (!n || typeof n !== 'object') return n
    const ls = n.layoutStyle || {}
    const out = { ...n }
    // 兼容三种几何载体
    if (ls.relativeX != null || ls.width != null || Object.keys(ls).length) {
      out.layoutStyle = {
        ...ls,
        ...(ls.relativeX != null ? { relativeX: dim(ls.relativeX) } : {}),
        ...(ls.relativeY != null ? { relativeY: dim(ls.relativeY) } : {}),
        ...(ls.x != null ? { x: dim(ls.x) } : {}),
        ...(ls.y != null ? { y: dim(ls.y) } : {}),
        ...(ls.width != null ? { width: dim(ls.width) } : {}),
        ...(ls.height != null ? { height: dim(ls.height) } : {}),
      }
    }
    if (n.x != null) out.x = dim(n.x)
    if (n.y != null) out.y = dim(n.y)
    if (n.width != null) out.width = dim(n.width)
    if (n.height != null) out.height = dim(n.height)
    // 缩放其余长度语义字段(防止 @2x 归一后圆角/描边/阴影/内边距仍翻倍)
    if (n.borderRadius != null) out.borderRadius = scaleLength(n.borderRadius, dim)
    if (n.padding != null) out.padding = scaleBox(n.padding, dim)
    if (n.stroke && typeof n.stroke === 'object') out.stroke = scaleStroke(n.stroke, dim)
    if (Array.isArray(n.effects)) out.effects = n.effects.map((e: any) => scaleEffect(e, dim))
    if (Array.isArray(n.textStyle)) {
      out.textStyle = n.textStyle.map((t: any) => scaleTextStyle(t, factor))
    } else if (n.textStyle) {
      out.textStyle = scaleTextStyle(n.textStyle, factor)
    }
    if (Array.isArray(n.children) && n.children.length) out.children = n.children.map(walkNode)
    return out
  }
  const scaledNodes = nodes.map(walkNode)

  const scaledStyles = {}
  for (const [key, def] of Object.entries(styles || {})) {
    const v = def && typeof def === 'object' && def.value ? def.value : def
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sv = { ...v }
      if (sv.size != null) sv.size = dim(sv.size)
      if (sv.lineHeight != null && isFinite(Number(sv.lineHeight))) sv.lineHeight = dim(Number(sv.lineHeight))
      if (sv.letterSpacing != null && isFinite(Number(sv.letterSpacing))) sv.letterSpacing = dim(Number(sv.letterSpacing))
      scaledStyles[key] = def && typeof def === 'object' && def.value ? { ...def, value: sv } : sv
    } else {
      scaledStyles[key] = def
    }
  }
  return { nodes: scaledNodes, styles: scaledStyles }
}

function scaleTextStyle(ts, f) {
  if (!ts || typeof ts !== 'object') return ts
  const dim = dimBy(f)
  const out = { ...ts }
  if (out.fontSize != null) out.fontSize = dim(out.fontSize)
  if (out.lineHeight != null && isFinite(Number(out.lineHeight))) out.lineHeight = dim(Number(out.lineHeight))
  if (out.letterSpacing != null && isFinite(Number(out.letterSpacing))) out.letterSpacing = dim(Number(out.letterSpacing))
  return out
}

/**
 * 解析倍率参数 (resolveDesignScale): 统一 CLI/MCP 的 scale 入参语义。
 * - 数值 n(>0 且 ≠1): 显式声明, source='explicit'
 * - 'auto': 启发式检测(source='inferred', 低置信不采纳回退 1)
 * - 其余/null: 不归一, 返回 null(蓝图不带 scale 字段)
 */
export function resolveDesignScale(scale, detectInput: Record<string, any> = {}) {
  if (scale == null || scale === '' || scale === 1 || scale === '1') return null
  if (scale === 'auto') {
    const d = detectDesignScale(detectInput)
    const adopted = d && d.confidence >= 0.6 ? d.scale : 1
    return {
      factor: adopted,
      source: 'inferred',
      confidence: d ? d.confidence : 0,
      detection: d,
      effective: adopted !== 1 ? adopted : null,
    }
  }
  const n = Number(scale)
  if (!isFinite(n) || n <= 0) throw new Error(`非法 scale: ${scale}(应为正数或 'auto')`)
  return n === 1 ? null : { factor: n, source: 'explicit', confidence: 1, effective: n }
}
