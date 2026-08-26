// 整树标注: 递归对每个容器反推布局语义 + 建议命名
import { inferLayout } from '@ui-restore/core'

const round = (n) => Math.round((n || 0) * 100) / 100

// 语义命名(纯算法启发式): 文本优先, 其次按布局形态
function suggestName(node, inferred) {
  const text = firstText(node, 0)
  if (text) return text.trim().slice(0, 24)
  if (inferred.position === 'absolute') return 'absolute-layer'
  if (inferred.flexDirection === 'row') return 'row-group'
  if (inferred.flexDirection === 'column') return 'column-group'
  return 'layer'
}

function firstText(node, depth) {
  if (depth > 3 || !node) return null
  if (node.type === 'TEXT') return node.text && node.text[0] && node.text[0].text
  for (const c of node.children || []) {
    const t = firstText(c, depth + 1)
    if (t) return t
  }
  return null
}

// 递归标注一个节点树
function annotate(nodes, stats) {
  const result = []
  for (const node of nodes) {
    result.push(annotateNode(node, stats))
  }
  return result
}

function annotateNode(node, stats) {
  const ls = node.layoutStyle || {}
  const kids = node.children || []
  stats.total++
  const entry = {
    id: node.id,
    name: node.name ?? '',
    type: node.type,
    layout: null,
    suggestedName: null,
    children: [],
  }

  if (kids.length > 0) {
    stats.containers++
    const kidsData = kids.map((k) => {
      const kls = k.layoutStyle || {}
      return {
        id: k.id,
        x: kls.relativeX ?? 0,
        y: kls.relativeY ?? 0,
        width: kls.width,
        height: kls.height,
        rotation: kls.rotate ?? 0,
      }
    })
    const inferred = inferLayout({ container: { width: ls.width, height: ls.height }, children: kidsData })
    entry.layout = {
      position: inferred.position,
      flexDirection: inferred.flexDirection ?? null,
      alignItems: inferred.alignItems ?? null,
      justifyContent: inferred.justifyContent ?? null,
      gap: inferred.gap ?? null,
      padding: inferred.padding ?? null,
      mainSizing: inferred.mainSizing ?? null,
      crossSizing: inferred.crossSizing ?? null,
      flexWrap: inferred.flexWrap ?? null,
      confidence: inferred.confidence ?? 0,
      absolutes: inferred.absolutes ?? [],
    }
    if (inferred.position === 'flex') {
      entry.suggestedName = suggestName(node, inferred)
      stats.flex++
    } else {
      stats.absolute++
    }
  }
  entry.children = annotateNodeList(kids, stats)
  return entry
}

function annotateNodeList(kids, stats) {
  const out = []
  for (const k of kids) {
    out.push(annotateNode(k, stats))
  }
  return out
}

export { annotate, annotateNode, suggestName }