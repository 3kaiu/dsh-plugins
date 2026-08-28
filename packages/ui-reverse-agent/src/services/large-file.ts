'use strict'
// large-file — 大文件性能（doc14 §7 31 sections/废弃图层）
// 输入：sections 数组（拍平稿）或 DSL nodes
// 输出：过滤后 sections + 分页建议 + 诊断计数

export function filterAbandonedSections(sections, canvas = { width: 1440, height: 900 }) {
  const kept = []
  let dropped = 0
  for (const s of sections) {
    const bbox = s.bbox || s.layoutStyle || s.rect || {}
    const x = bbox.x ?? 0, y = bbox.y ?? 0, w = bbox.width ?? bbox.w ?? 100, h = bbox.height ?? bbox.h ?? 100
    const outside = (x + w < 0) || (x > canvas.width) || (y + h < 0) || (y > canvas.height)
    if (outside) { dropped++; continue }
    kept.push(s)
  }
  return { kept, dropped, total: sections.length }
}

export function paginateSections(sections, pageSize = 10) {
  const pages = []
  for (let i = 0; i < sections.length; i += pageSize) {
    pages.push({ page: Math.floor(i / pageSize), start: i, end: Math.min(i + pageSize, sections.length), sections: sections.slice(i, i + pageSize) })
  }
  return { pages, pageSize, total: sections.length, pageCount: pages.length }
}

export function largeFileDiagnostics(sections, canvas) {
  const { kept, dropped } = filterAbandonedSections(sections, canvas)
  const { pages, pageCount } = paginateSections(kept, 10)
  const hasFlex = kept.filter(s => s.flexContainerInfo).length
  const allAbsolute = hasFlex === 0
  return {
    total: sections.length,
    kept: kept.length,
    dropped,
    pageCount,
    hasFlex,
    allAbsolute,
    recommendation: dropped > 0 ? `过滤 ${dropped} 废弃图层` : allAbsolute ? 'flex 全缺，absolute 保底' : 'normal',
  }
}
