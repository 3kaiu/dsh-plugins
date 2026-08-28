'use strict'
// design-system — 设计系统生成（tokens/components 自动抽取，Phase2 复用资产的结构化）

export function generateDesignSystem(blueprint) {
  const palette = blueprint.palette || []
  const profile = blueprint.typographyProfile || {}
  const tree = blueprint.tree || []

  // tokens：colors, spacing, typography
  const tokens = {
    colors: palette.slice(0, 8).map((c, i) => ({ name: `color-${i}`, value: c.hex || c, count: c.count || 1 })),
    typography: Object.entries(profile).slice(0, 6).map(([path, spec]) => ({ name: path.replace(/[^a-z0-9]/gi,'-'), ...spec })),
    spacing: [...new Set(collectSpacings(tree))].sort((a,b)=>a-b).slice(0,8),
  }

  // components：按 role 聚类（header/card/button）
  const byRole = {}
  function collectByRole(nodes) {
    for (const n of nodes) {
      const role = n.role || n.name || 'unknown'
      if (!byRole[role]) byRole[role] = []
      byRole[role].push(n)
      if (n.children) collectByRole(n.children)
    }
  }
  collectByRole(Array.isArray(tree) ? tree : [tree])
  const components = Object.entries(byRole)
    .filter(([_, v]) => v.length >= 1)
    .slice(0, 10)
    .map(([role, nodes]) => ({ role, count: nodes.length, example: nodes[0].name || role }))

  return { tokens, components, summary: `${tokens.colors.length} colors, ${tokens.typography.length} typos, ${components.length} comps` }
}

function collectSpacings(tree) {
  const out = []
  function walk(nodes) {
    for (const n of nodes) {
      if (n.computed?.gap) out.push(parseInt(n.computed.gap,10))
      if (n.computed?.padding) out.push(...String(n.computed.padding).split(' ').map(v=>parseInt(v,10)).filter(v=>!isNaN(v)))
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree])
  return out.filter(v=>!isNaN(v) && v>0)
}
