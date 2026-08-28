'use strict'
// bundle-analysis — 产物分析（体积/组成/外置，基于 esbuild metafile）

import fs from 'node:fs'

export function analyzeBundle(distPath = 'dist/index.js') {
  try {
    const stat = fs.statSync(distPath)
    const content = fs.readFileSync(distPath, 'utf8')
    const lines = content.split('\n').length
    const hasMinify = content.includes('=>') && lines < 300
    const hasTypes = /[\n;]interface\s+\w+\s*\{/.test(content) || /:\s*string\s*;/.test(content)
    return {
      path: distPath,
      bytes: stat.size,
      kb: Math.round(stat.size / 1024),
      lines,
      minified: hasMinify && stat.size < 200 * 1024,
      hasTypes,
      summary: `${Math.round(stat.size/1024)}K / ${lines} lines / ${hasMinify ? 'minified' : 'unminified'} / ${hasTypes ? 'has types!' : 'no types'}`,
    }
  } catch (e) {
    return { path: distPath, error: String(e) }
  }
}

export function strictReport() {
  // 渐进式 strict 收敛建议（基于 tsc --strict 的错误聚类）
  return {
    current: 'strict:false (allowImportingTsExtensions:true, skipLibCheck:true)',
    next: 'strict:true 需：① 显式 any 标注 ② 声明 shared 的 d.ts ③ 修复 layout 隐式 any',
    steps: [
      '1. 为 @3kaiu/dsh-plugin-kit 补充 d.ts（esbuild 已产 JS，需 tsc --emitDeclarationOnly）',
      '2. 对 src/**/*.ts 批量加 // @ts-nocheck 分批收敛，或 noImplicitAny:false 先过',
      '3. 优先收敛 guard/services 等纯函数（fanout/security 等已近 strict）',
      '4. 最后收敛 layout-infer 的 annotate/classify（大量隐式 any，需重构）',
    ]
  }
}
