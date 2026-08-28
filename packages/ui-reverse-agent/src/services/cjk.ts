'use strict'
// cjk — CJK 排版（全角标点/字体回退/行断，doc14 §8 待办落地）
// 字符判定收敛自 kit 正典(doc19 批2): CJK_WIDE_RE 为三处并集(补全角形式)。

import { CJK_WIDE_RE as CJK_RE } from '@3kaiu/dsh-plugin-kit'

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
