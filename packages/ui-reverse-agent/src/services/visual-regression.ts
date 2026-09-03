'use strict'
// visual-regression — 与 Percy/Chromatic 等视觉回归平台的对比（增量）
// 输入：artifacts（diff 热图 + score），输出：兼容 Percy 的快照描述

export function toPercySnapshot({ name, url, widths = [375, 768, 1440], minHeight = 1024 }: any) {
  return {
    name: name || 'ui-reverse',
    url: url || 'http://localhost:3000',
    widths,
    minHeight,
    percyCSS: `.ui-reverse-diff { outline: 2px solid red; }`,
  }
}

export function toChromaticSnapshot({ name, viewport, diffPath, score }: any) {
  return {
    name: name || `ui-reverse:${viewport || 'desktop'}`,
    viewport: viewport || 'desktop',
    diff: diffPath,
    score: score?.total ?? 0,
    threshold: 0.96,
    passed: (score?.total ?? 0) >= 0.96,
  }
}
