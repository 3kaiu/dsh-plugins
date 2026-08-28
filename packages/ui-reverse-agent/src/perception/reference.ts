'use strict'
// reference_ingest：截图/DSL/URL → blueprint.json
// 输入：{ dsl, screenshotPaths, url, viewport }
// - dsl：MasterGo DSL 对象或拍平稿 sections 数组
// - screenshotPaths：参考截图路径数组
// - url：参考 URL（走 browser_dom_dump + page_layout_tree 管线）
// 输出：blueprint（见 shared/blueprint）+ 落盘 .ui-reverse/blueprint.json

import fs from 'node:fs'
import path from 'node:path'
import { buildBlueprint } from '@3kaiu/dsh-plugin-kit'

export async function referenceIngest({ dsl, screenshotPaths, url, viewport, outPath } = {}, deps = {}) {
  const { classifyDsl, annotate, cleanToStandardDsl } = deps
  // 兼容多种 dsl 形态
  let tree = null, canvas = null, styles = null, meta = null

  if (dsl) {
    // 尝试标准 DSL
    if (dsl.root && dsl.meta) {
      tree = [dsl.root]
      canvas = dsl.meta.canvas
      styles = dsl.styles
      meta = dsl.meta
    } else if (dsl.nodes && Array.isArray(dsl.nodes)) {
      // MasterGo 原始 DSL
      if (classifyDsl) {
        const cls = classifyDsl(dsl)
        // classifyDsl 输出含 assets/树；取树
        // 若 classify 输出结构含 tree 字段
        tree = cls.tree || cls.roots || []
        // 另：annotate 整树
        if (!tree.length && annotate) {
          const nodes = dsl.nodes
          const stats = { total:0, containers:0, flex:0, absolute:0 }
          tree = annotate(nodes, stats)
        }
      } else {
        // 无分类器时直接用 nodes 作为 tree
        tree = dsl.nodes
      }
      styles = dsl.styles
      canvas = { width: 1440, height: 900 }
    } else if (Array.isArray(dsl) && cleanToStandardDsl) {
      // 拍平稿 sections
      const cleaned = cleanToStandardDsl({ canvas: viewport || { width: 375, height: 812 }, sections: dsl })
      tree = [cleaned.root]
      canvas = cleaned.meta.canvas
      styles = cleaned.styles
      meta = cleaned.meta
    }
  }

  if (url && deps.browserDomDump) {
    // URL 参考：复用实现侧相同管线
    const dump = await deps.browserDomDump({ selector: 'body', includeComputed: true })
    // 需 page_layout_tree 转换（由调用方在 deps.domToLayout 提供）
    if (deps.domToLayout) {
      const laid = deps.domToLayout(dump)
      tree = laid.tree
      canvas = laid.canvas
    } else {
      tree = dump.tree
      canvas = dump.viewport
    }
  }

  if (!tree) tree = []
  if (!canvas) canvas = viewport || { width: 1440, height: 900 }

  const blueprint = buildBlueprint({ canvas, tree, styles, dsl: dsl && { styles, nodes: tree }, screenshotPaths, viewport: canvas })

  // 落盘
  const out = outPath || '.ui-reverse/blueprint.json'
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(blueprint, null, 2))
  } catch {}

  return { blueprint, outPath: out, summary: { canvas, regions: blueprint.regions.length, assets: blueprint.assets } }
}
