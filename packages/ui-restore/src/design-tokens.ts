// design-tokens.ts - W3C DTCG 设计 token 层
// 从蓝图提取去重后的样式事实(颜色/字号/字重/行高/圆角/阴影), 按 Design Tokens Community
// Group 格式输出($value/$type)。命名按"用途分组 + 频次/数值排序索引"(color.text.1,
// font.size.1 ...), 业务无关、技术栈中立 —— 语义 token 名本身就是给下游 LLM 的强约束提示,
// 且可被 style-dictionary 等 DTCG 兼容工具直接消费转任意平台。
//
// 布局几何(层级/gap/padding/bounds)刻意不进 token 层: 那是蓝图的职责, token 只管可主题化样式。

import { round2 } from './numeric.ts'

function dim(n: any) {
  return { value: round2(n), unit: "px" }
}

class Collector {
  map: Map<any, number>;
  constructor() {
    this.map = new Map() // value -> count
  }
  add(value) {
    if (value == null || value === "") return
    this.map.set(value, (this.map.get(value) || 0) + 1)
  }
  // 命名: 频次降序 -> 字典序升序, 稳定确定
  names(prefix) {
    const entries = [...this.map.entries()].sort((a: any, b: any) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
    return entries.map(([v], i) => ({ value: v, token: `${prefix}.${i + 1}` }))
  }
}

function hexToRgbaStr(color, fallbackAlpha = 1) {
  if (typeof color !== "string") return null
  const c = color.trim()
  // 已是 rgba()/rgb() 串: 保真透传(阴影自带透明度不丢失)
  if (/^rgba?\(/i.test(c)) return c
  if (!c.startsWith("#")) return null
  let v = c.slice(1)
  if (v.length === 3) v = v.split("").map((ch: any) => ch + ch).join("")
  if (v.length === 6) {
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${round2(fallbackAlpha)})`
  }
  // #RRGGBBAA: alpha 内嵌于色值, 保真解析
  if (v.length === 8) {
    const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16)
    const a = parseInt(v.slice(6, 8), 16) / 255
    return `rgba(${r}, ${g}, ${b}, ${round2(a)})`
  }
  return null
}

/**
 * 从蓝图提取 DTCG 设计 token (extractDesignTokens)
 *
 * @param {object} blueprint generateCodeBlueprint 输出({tree, floatings})
 * @param {object} [opts] includeAliases: 是否输出逐节点别名表(默认 true;
 *   蓝图内嵌时传 false 防止产物膨胀 —— token 定义本身已含全部信息)
 * @returns {{tokens: object, aliases: Array<{nodeId, property, token}>, stats: object}}
 */
export function extractDesignTokens(blueprint, opts: Record<string, any> = {}) {
  if (!blueprint) return null
  const includeAliases = opts.includeAliases !== false
  const textColor = new Collector(), bgColor = new Collector()
  const fontSizes = new Collector(), fontWeights = new Collector(), lineHeights = new Collector()
  const radii = new Collector()
  const shadows = new Map() // 序列化签名 -> {value, count}
  const aliases = []

  const visit = (node: any) => {
    if (!node || typeof node !== "object") return
    const ly = node.layout || {}
    if (node.color) {
      const isText = node.type === "TEXT" || node.text
      const col = isText ? textColor : bgColor
      col.add(node.color)
      aliases.push({ nodeId: node.id, property: isText ? "textColor" : "background", token: null, _col: col, _raw: node.color })
    }
    if (node.type === "TEXT") {
      if (node.fontSize != null) { fontSizes.add(round2(node.fontSize)); aliases.push({ nodeId: node.id, property: "fontSize", token: null, _col: fontSizes, _raw: round2(node.fontSize) }) }
      if (node.fontWeight != null) { fontWeights.add(Number(node.fontWeight)); aliases.push({ nodeId: node.id, property: "fontWeight", token: null, _col: fontWeights, _raw: Number(node.fontWeight) }) }
      if (node.lineHeight != null) { lineHeights.add(round2(node.lineHeight)); aliases.push({ nodeId: node.id, property: "lineHeight", token: null, _col: lineHeights, _raw: round2(node.lineHeight) }) }
    }
    const radius = ly.borderRadius
    if (radius != null) {
      const vals = Array.isArray(radius) ? [...new Set(radius.filter((r: any) => r > 0))] : [radius]
      for (const r of vals) { radii.add(round2(r)); aliases.push({ nodeId: node.id, property: "borderRadius", token: null, _col: radii, _raw: round2(r) }) }
    }
    for (const eff of ly.effects || []) {
      if (eff.type !== "DROP_SHADOW") continue
      const sig = JSON.stringify([eff.offsetX, eff.offsetY, eff.blur, eff.spread, eff.color])
      if (!shadows.has(sig)) shadows.set(sig, { value: { offsetX: dim(eff.offsetX || 0), offsetY: dim(eff.offsetY || 0), blur: dim(eff.blur || 0), spread: dim(eff.spread || 0), color: hexToRgbaStr(eff.color) || "rgba(0, 0, 0, 0.15)" }, count: 0 })
      shadows.get(sig).count++
      aliases.push({ nodeId: node.id, property: "shadow", token: null, _sig: sig })
    }
    for (const c of node.children || []) visit(c)
  }
  for (const root of [...(blueprint.tree || []), ...(blueprint.floatings || [])]) visit(root)

  const named = {
    textColor: textColor.names("color.text"),
    bgColor: bgColor.names("color.bg"),
    fontSize: fontSizes.names("font.size"),
    fontWeight: fontWeights.names("font.weight"),
    lineHeight: lineHeights.names("font.lineHeight"),
    radius: radii.names("radius"),
  }
  // 组内查找需隔离: 直接用 name 列表建 per-group map
  const groupMap = (list: any) => new Map(list.map(({ value, token }) => [String(value), token]))
  const mTextColor = groupMap(named.textColor), mBgColor = groupMap(named.bgColor)
  const mFontSize = groupMap(named.fontSize), mFontWeight = groupMap(named.fontWeight)
  const mLineHeight = groupMap(named.lineHeight), mRadius = groupMap(named.radius)

  // 阴影命名: 频次降序
  const shadowList = [...shadows.entries()]
    .map(([sig, s]) => ({ sig, ...s }))
    .sort((a: any, b: any) => b.count - a.count)
    .map((s: any, i: any) => ({ ...s, token: `shadow.1.${i + 1}` }))
  const mShadow = new Map(shadowList.map((s: any) => [s.sig, s.token]))

  // 回填 alias token 名
  for (const a of aliases) {
    if (a._col) {
      const m = a._col === textColor ? mTextColor : a._col === bgColor ? mBgColor : a._col === fontSizes ? mFontSize : a._col === fontWeights ? mFontWeight : a._col === lineHeights ? mLineHeight : mRadius
      a.token = m.get(String(a._raw)) || null
    } else if (a._sig) {
      a.token = mShadow.get(a._sig) || null
    }
    delete a._col; delete a._raw; delete a._sig
  }

  const tokens = {}
  const put = (name: any, def: any) => { tokens[name] = def }
  for (const { value, token } of named.textColor) put(token, { $type: "color", "$value": String(value) })
  for (const { value, token } of named.bgColor) put(token, { $type: "color", "$value": String(value) })
  for (const { value, token } of named.fontSize) put(token, { $type: "dimension", "$value": dim(value) })
  for (const { value, token } of named.fontWeight) put(token, { $type: "fontWeight", "$value": Number(value) })
  for (const { value, token } of named.lineHeight) put(token, { $type: "dimension", "$value": dim(value) })
  for (const { value, token } of named.radius) put(token, { $type: "dimension", "$value": dim(value) })
  for (const s of shadowList) put(s.token, { $type: "shadow", "$value": s.value })

  return {
    tokens,
    aliases: includeAliases ? aliases.filter((a: any) => a.token) : [],
    stats: {
      colorTextInput: named.textColor.length,
      colorBg: named.bgColor.length,
      fontSizes: named.fontSize.length,
      radii: named.radius.length,
      shadows: shadowList.length,
    },
  }
}
