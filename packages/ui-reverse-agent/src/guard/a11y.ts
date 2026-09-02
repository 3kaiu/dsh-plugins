'use strict'
// a11y — 可访问性守卫（Phase6 验证，与 anti_hack/verify_neutral 互补）
// 输入：implementedTree / domDump（需含 tag/role/alt/text）
// 输出：{passed, violations, warnings} — 语义化、alt、heading 层级、对比度

function luminance(hex: any) {
  const h = hex.replace('#','')
  const r = h.length===3 ? parseInt(h[0]+h[0],16) : parseInt(h.slice(0,2),16)
  const g = h.length===3 ? parseInt(h[1]+h[1],16) : parseInt(h.slice(2,4),16)
  const b = h.length===3 ? parseInt(h[2]+h[2],16) : parseInt(h.slice(4,6),16)
  const toL = (c: any) => { const s = c/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055,2.4) }
  return 0.2126*toL(r) + 0.7152*toL(g) + 0.0722*toL(b)
}
function contrastRatio(fg: any, bg: any) {
  const l1 = luminance(fg), l2 = luminance(bg)
  const lighter = Math.max(l1,l2), darker = Math.min(l1,l2)
  return (lighter + 0.05) / (darker + 0.05)
}

export function checkA11y({ tree, domDump, palette }: Record<string, any> = {}) {
  const nodes = flatten(tree || domDump?.tree || [])
  const violations = []
  const warnings = []

  // 1. 语义化：header/nav/main/aside/footer/section 应使用语义标签而非 div
  const semanticRoles = ['banner','navigation','main','complementary','contentinfo']
  for (const n of nodes) {
    const role = (n.role || '').toLowerCase()
    const tag = (n.tag || n.type || '').toLowerCase()
    if (semanticRoles.includes(role) && tag === 'div') {
      warnings.push({ rule: 'semantic-tag', path: n.name||n.id, role, tag, reason: `role=${role} 建议用语义标签而非 div` })
    }
    // 按钮/链接应有可访问名称
    if ((role === 'button' || tag === 'button' || tag === 'a') && !n.text && !n.alt && !n.ariaLabel) {
      violations.push({ rule: 'accessible-name', path: n.name||n.id, tag, reason: '交互元素缺可访问名称' })
    }
  }

  // 2. 图片 alt
  for (const n of nodes) {
    const tag = (n.tag || '').toLowerCase()
    if (tag === 'img' || n.type === 'LAYER') {
      if (!n.alt && !n.ariaLabel) {
        warnings.push({ rule: 'img-alt', path: n.name||n.id, reason: '图片缺 alt/aria-label' })
      }
    }
  }

  // 3. 标题层级（h1→h2→h3 不跳级）
  const headings = nodes.filter(n => /^h[1-6]$/.test((n.tag||'').toLowerCase()) || n.role === 'heading')
  let lastLevel = 0
  for (const h of headings) {
    const level = parseInt((h.tag||'h1').slice(1),10) || parseInt(h.level||'1',10) || 1
    if (lastLevel && level > lastLevel + 1) {
      warnings.push({ rule: 'heading-order', path: h.name||h.id, level, lastLevel, reason: `标题跳级 h${lastLevel}→h${level}` })
    }
    lastLevel = level
  }

  // 4. 对比度（文本色 vs 背景色，WCAG AA 4.5:1，基于 palette 或节点 computed）
  for (const n of nodes) {
    const fg = n.computed?.color || n._color || n.textColor
    const bg = n.computed?.backgroundColor || n.fill || n._neutral?.bg
    if (fg && bg && typeof fg === 'string' && typeof bg === 'string' && fg.startsWith('#') && bg.startsWith('#')) {
      const ratio = contrastRatio(fg, bg)
      if (ratio < 4.5) {
        warnings.push({ rule: 'contrast', path: n.name||n.id, fg, bg, ratio: Math.round(ratio*10)/10, reason: `对比度 ${Math.round(ratio*10)/10} < 4.5 (AA)` })
      }
    }
  }

  const passed = violations.length === 0
  return {
    passed,
    violations,
    warnings,
    summary: passed ? (warnings.length ? `warnings: ${warnings.length}` : 'a11y pass') : `violations: ${violations.map(v=>v.rule).join(',')}`,
  }
}

function flatten(tree: any) {
  const out = []
  function walk(nodes: any) {
    for (const n of nodes) {
      out.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree])
  return out
}
