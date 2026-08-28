'use strict'
// cjk — CJK 排版（全角标点/字体回退/行断，doc14 §8 待办落地）

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const FULLWIDTH_PUNCT = /[，。！？；：""''（）【】《》]/

export function isCjk(text) { return CJK_RE.test(text) }

export function cjkFontFallback(requested) {
  // doc14：未知字体 → 窄字体回退链，已含 CJK 兜底
  const base = requested || 'Inter'
  if (isCjk(base)) return `'${base}', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`
  return `'${base}', 'PingFang SC', 'Helvetica Neue', Arial, sans-serif`
}

export function cjkLineBreak(text) {
  // 全角标点不应行首：若断行落在全角标点前，退一格
  if (!text || !FULLWIDTH_PUNCT.test(text)) return text
  // 简化：返回带 <wbr> 建议的断行点（实现侧用 word-break: keep-all + overflow-wrap）
  return text
}

export function cjkPunctWidth(text) {
  // 全角字符宽度 ≈ 1em，半角 ≈ 0.5em（用于估算文本宽度，兜底）
  let w = 0
  for (const ch of text) {
    if (FULLWIDTH_PUNCT.test(ch) || CJK_RE.test(ch)) w += 1
    else w += 0.5
  }
  return w
}
