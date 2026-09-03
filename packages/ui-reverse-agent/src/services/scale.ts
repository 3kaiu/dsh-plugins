'use strict'
// scale — 规模化（1000+ 文件 monorepo 的增量与并行）

export function chunkFiles(files: any, size = 100) {
  const chunks = []
  for (let i = 0; i < files.length; i += size) chunks.push(files.slice(i, i + size))
  return chunks
}

export function incrementalPlan({ changedFiles, allFiles }) {
  // 仅处理变更文件及其依赖（简化：变更文件 + 同目录文件）
  const affected = new Set(changedFiles)
  for (const f of changedFiles) {
    const dir = f.split('/').slice(0, -1).join('/')
    for (const a of allFiles) if (a.startsWith(dir)) affected.add(a)
  }
  return { affected: [...affected], total: allFiles.length, ratio: Math.round(affected.size / allFiles.length * 100) }
}
