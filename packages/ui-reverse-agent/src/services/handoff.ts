'use strict'
// handoff — 设计交付文档自动产出（供设计师/开发者验收）
// 输入：blueprint + state + score，输出：markdown handoff

export function generateHandoff({ blueprint, state, score }: Record<string, any> = {}) {
  const lines = [
    `# UI 还原交付文档`,
    ``,
    `> 自动生成于 ${new Date().toISOString().slice(0,10)}，基于 ${blueprint?.meta?.source || 'unknown'} 蓝图`,
    ``,
    `## 总览`,
    `- 总分 S ${score?.total ?? state?.scores?.current?.total ?? '?'} / 阈值 0.96`,
    `- 迭代 ${state?.iteration ?? '?'} 轮，剩余 ${state?.remainingDifferences?.length ?? '?'} 项`,
    `- 画布 ${blueprint?.canvas?.width}x${blueprint?.canvas?.height}，背景 ${blueprint?.canvas?.background || '—'}`,
    ``,
    `## 资产清单`,
    `- 图标 ${blueprint?.assets?.icons?.length ?? 0}：${(blueprint?.assets?.icons || []).slice(0,3).map(i=>i.name).join(', ') || '—'}`,
    `- 图片 ${blueprint?.assets?.images?.length ?? 0}`,
    `- 字体 ${blueprint?.assets?.fonts?.join(', ') || '—'}`,
    ``,
    `## 分层分数`,
    `- 结构 ${score?.layers?.struct ?? '?'} / 几何 ${score?.layers?.geom ?? '?'} / 像素 ${score?.layers?.pixel ?? '?'} / 排版 ${score?.layers?.type ?? '?'} / 色彩 ${score?.layers?.color ?? '?'}`,
    ``,
    `## 剩余差异（按优先级）`,
    ...((state?.remainingDifferences || []).slice(0,5).map(d => `- [${d.priority}] ${d.path} ${d.prop}: ${d.expected} vs ${d.actual} (Δ${d.delta})`)),
    ``,
    `## 已解决`,
    ...((state?.resolvedDifferences || []).slice(-3).map(d => `- ${d.path} ${d.prop} (iter ${d.iteration})`)),
  ]
  return lines.join('\n')
}
