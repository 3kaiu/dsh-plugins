// text-metrics.ts - 文本度量校准
// 用真实字体文件(opentype.js)计算文本 advance width 与换行预测,
// 替代纯启发式的 maxLines/溢出判定。字体不可用时退化为按字宽估算(CJK 1.0em / 拉丁 0.52em),
// 永不阻塞主流程 —— 度量是增强, 不是依赖。
//
// 字体解析限制: opentype.js 不支持 TTC 集合(如 PingFang.ttc/Hiragino.ttc),
// 只接受单文件 TTF/OTF。macOS 上可用的 CJK 单文件字体如 'Arial Unicode.ttf'。
// 授权注意: 度量只在本地读取系统字体做计算, 不随产物分发字体文件。

import fs from "node:fs"
import { round2 } from "./numeric.ts"

let _font: any = null
let _fontSource: any = null
let _loadAttempted = false

// 常见单文件 CJK 兼容字体探测列表(按优先级；覆盖 macOS/主流 Linux 发行版)
const FONT_CANDIDATES = [
  process.env.DSH_TEXT_FONT_PATH,
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/PingFang.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
  "/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf",
  "/usr/share/fonts/truetype/arphic/uming.ttc",
  "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf",
].filter(Boolean)

/**
 * 初始化文本度量 (initTextMetrics)
 * 尝试加载可用字体; 成功后蓝图 TEXT 节点会带 measured 字段。
 * 异步: 需在调用 generateCodeBlueprint 前 await 本函数(可选步骤)。
 */
export async function initTextMetrics(opts: Record<string, any> = {}) {
  if (_loadAttempted && !opts.force) return measurerInfo()
  _loadAttempted = true
  const paths = opts.fontPath ? [opts.fontPath, ...FONT_CANDIDATES] : FONT_CANDIDATES
  const { parse } = await import("opentype.js") as any
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue
      const buf = fs.readFileSync(p)
      _font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      _fontSource = p
      return measurerInfo()
    } catch {
      // 尝试下一个候选
    }
  }
  _font = null
  _fontSource = null
  return measurerInfo()
}

/** 当前度量器状态 */
export function measurerInfo() {
  return {
    available: !!_font,
    fontPath: _fontSource,
    fontFamily: _font?.names?.fontFamily?.en || null,
    mode: _font ? "font" : "heuristic",
  }
}

/** 单行宽度(px): 字体模式走 advance width(kerning 开启), 否则字宽估算 */
export function measureTextWidth(text: any, fontSize: any, letterSpacing = 0) {
  const str = String(text ?? "")
  if (!str) return 0
  if (_font) {
    try {
      return round2(_font.getAdvanceWidth(str, fontSize, { kerning: true }) + letterSpacing * Math.max(0, str.length - 1))
    } catch {
      // 落入估算
    }
  }
  let w = 0
  for (const ch of str) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? fontSize : fontSize * 0.52
  return round2(w + letterSpacing * Math.max(0, [...str].length - 1))
}

/**
 * 换行预测 (predictTextLayout)
 * 贪心逐字符填充(CJK 逐字可断; 连续拉丁串视作一个不可断 token),
 * 返回单行宽与换行后的行数组 —— 校准蓝图的 maxLines / softWrap 判定。
 */
export function predictTextLayout({ text, fontSize, maxWidth, letterSpacing = 0 }: any) {
  const str = String(text ?? "")
  const singleLineWidth = measureTextWidth(str, fontSize, letterSpacing)
  if (!maxWidth || maxWidth <= 0 || singleLineWidth <= maxWidth) {
    return { singleLineWidth, fitsOneLine: true, lines: 1, overflow: false }
  }
  // tokenize: 连续拉丁/数字为一个 token, 其余逐字符
  const tokens = str.match(/[A-Za-z0-9]+|./gs) || []
  const lines = []
  let cur = "", curW = 0
  for (const tk of tokens) {
    const tw = measureTextWidth(tk, fontSize, letterSpacing)
    if (cur && curW + tw > maxWidth) {
      lines.push(cur)
      cur = tk; curW = tw
    } else {
      cur += tk; curW += tw
    }
  }
  if (cur) lines.push(cur)
  return { singleLineWidth, fitsOneLine: false, lines: lines.length, overflow: lines.length > 1 }
}
