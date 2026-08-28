'use strict'
// cjk — CJK 全角字符判定单一来源(doc19 §2.2 批2)
//
// 收敛背景: 三处各自为政的字符类已实际分叉 —— ura/services/cjk.ts 漏全角形式,
// llm/sse.ts 的码点判定漏假名/兼容表意/全角(分词宽度估算系统性偏低),
// ui-restore/text-metrics.ts 最全。本模块取并集为正典: CJK 部首扩展 + 假名 +
// CJK 统一表意(含扩展A) + 兼容表意 + 全角形式 + CJK 符号标点。
// llm 包刻意不依赖 kit(运行时分层), 其 sse.ts 内联同区间副本并注本指针;
// ui-restore 批3 接 kit 后改引本模块。

export const CJK_WIDE_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/

/** 文本是否含 CJK 全角字符(排版宽度/分词估算/字体回退判定用) */
export function isCjkText(s) {
  return CJK_WIDE_RE.test(String(s ?? ''))
}
