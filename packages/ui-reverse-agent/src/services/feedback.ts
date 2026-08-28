'use strict'
// feedback — 用户反馈闭环（人工校正的捕获与回放）
// 输入：用户对某轮差异的“不对，应改 X”的自然语言，输出：结构化 feedback 写入 .ui-reverse/feedback.json 供后续回放/微调

import fs from 'node:fs'
import path from 'node:path'

export function captureFeedback({ iteration, path: p, prop, expected, actual, userCorrection, reason }, { feedbackPath = '.ui-reverse/feedback.json' } = {}) {
  const entry = { iteration, path: p, prop, expected, actual, userCorrection, reason, at: new Date().toISOString() }
  try {
    fs.mkdirSync(path.dirname(feedbackPath), { recursive: true })
    const cur = fs.existsSync(feedbackPath) ? JSON.parse(fs.readFileSync(feedbackPath, 'utf8')) : []
    cur.push(entry)
    fs.writeFileSync(feedbackPath, JSON.stringify(cur, null, 2))
    return { entry, count: cur.length, feedbackPath }
  } catch (e) {
    return { entry, error: String(e) }
  }
}

export function loadFeedback(feedbackPath = '.ui-reverse/feedback.json') {
  try {
    if (!fs.existsSync(feedbackPath)) return []
    return JSON.parse(fs.readFileSync(feedbackPath, 'utf8'))
  } catch { return [] }
}

export function replayFeedback(feedback, blueprint) {
  // 将历史 feedback 转为“约束”（如用户曾纠正 gap 24 而非 16，则后续 fanout 优先 24）
  const constraints = { spacingScale: new Set(), colorPalette: new Set() }
  for (const fb of feedback) {
    if (fb.prop === 'gap' || fb.prop === 'padding') constraints.spacingScale.add(fb.userCorrection)
    if (fb.prop === 'color') constraints.colorPalette.add(fb.userCorrection)
  }
  return {
    spacingScale: [...constraints.spacingScale],
    colorPalette: [...constraints.colorPalette],
    count: feedback.length,
    summary: feedback.length ? `回放 ${feedback.length} 条人工校正` : '无反馈',
  }
}
