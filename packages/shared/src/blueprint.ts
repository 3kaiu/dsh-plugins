'use strict'
// Visual Blueprint 构建（Perception.Reference）
// 输入：{ dsl, domDump, screenshotPaths, viewport }
// dsl: MasterGo DSL {styles, nodes, components} 或拍平稿 sections
// domDump: browser_dom_dump 输出（参考 URL 场景）
// screenshotPaths: 纯截图参考时的图片路径数组
// 输出：blueprint.json — { canvas, tree, typographyProfile, palette, assets, regions, viewports, states, meta }

// 避免循环依赖，classify/annotate 由调用方注入（见 blueprintFromDsl 参数）

function extractTypographyProfile(tree) {
  const profile = {}
  const walk = (nodes, path='') => {
    for (const n of nodes) {
      const p = path ? `${path} > ${n.name||n.id}` : (n.name||n.id)
      const t = (n.text||'').trim()
      if (t && n.computed) {
        // 将节点文本的排版抽象为 profile 项
        profile[p] = {
          family: n.computed.fontFamily || null,
          size: n.computed.fontSize != null ? parseFloat(n.computed.fontSize) : null,
          weight: n.computed.fontWeight || null,
          lineHeight: n.computed.lineHeight != null ? parseFloat(n.computed.lineHeight) : null,
          letterSpacing: n.computed.letterSpacing != null ? parseFloat(n.computed.letterSpacing) : null,
          color: n.computed.color || null,
          sample: t.slice(0,48),
        }
      } else if (t && n.font) {
        profile[p] = {
          family: n.font.family || n.font.fontFamily || null,
          size: n.font.size || n.font.fontSize || null,
          weight: n.font.weight || null,
          lineHeight: n.font.lineHeight || null,
          letterSpacing: n.font.letterSpacing || null,
          color: n.textColor || n._color || null,
          sample: t.slice(0,48),
        }
      }
      if (n.children) walk(n.children, p)
    }
  }
  walk(Array.isArray(tree)?tree:[tree])
  return profile
}

function extractAssets(tree, styles) {
  const images=[]
  const icons=[]
  const fonts=new Set()
  const texts=[]
  const walk=(nodes)=>{
    for(const n of nodes){
      if (n.type==='TEXT' && n.text) texts.push(n.text)
      if (Array.isArray(n.rowTexts)) for(const t of n.rowTexts) texts.push(typeof t==='string'?t:t.text)
      if (n.svgShortKey) icons.push({ id:n.id, key:n.svgShortKey, name:n.svgName||n.name })
      if (n.svgKey) icons.push({ id:n.id, key:n.svgKey, name:n.svgName||n.name })
      if (n.computed?.fontFamily) fonts.add(n.computed.fontFamily)
      if (n.font?.family) fonts.add(n.font.family)
      // image 需导出：IMAGE fill 或 img tag
      const tag=(n.tag||n.type||'').toLowerCase()
      if (tag==='img' || n.fill?.startsWith?.('url(') || n.fill?.startsWith?.('http')) {
        images.push({ id:n.id, src: n.fill || n.src || n.selector || '' })
      }
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree)?tree:[tree])
  // styles 中字体 token
  if (styles) {
    for(const v of Object.values(styles) as any[]){
      if (v?.value?.fontFamily) fonts.add(v.value.fontFamily)
      if (v?.value?.fontPostScript) fonts.add(v.value.fontPostScript)
    }
  }
  return { images, icons, fonts: [...fonts], texts: [...new Set(texts.filter(Boolean))].slice(0,200) }
}

function buildRegions(tree, canvas) {
  // 按角色/P 优先级切 region（简化：顶层容器即 region）
  const regions=[]
  const roots = Array.isArray(tree)?tree:[tree]
  for (const n of roots) {
    const role = n.role || n.name || 'region'
    let priority='P1'
    if (/header|nav|status|tab-bar/i.test(role)) priority='P0'
    else if (/card|section|main|sidebar/i.test(role)) priority='P0'
    else if (/icon|decoration/i.test(role)) priority='P2'
    const bbox = n.bbox || n.rect || n.layoutStyle || {}
    regions.push({
      id: n.id, name: n.name || role, role, priority,
      bbox: { x: bbox.x ?? 0, y: bbox.y ?? 0, width: bbox.width ?? bbox.w ?? canvas.width, height: bbox.height ?? bbox.h ?? 100 },
    })
  }
  return regions
}

export function buildBlueprint({ canvas, tree, styles, dsl, domDump, screenshotPaths, viewport }: Record<string, any> = {}) {
  // canvas
  const c = canvas || viewport || domDump?.viewport || dsl?.meta?.canvas || { width: 1440, height: 900 }
  // tree 已为标注树；若传入 dsl 且无 tree，则需外部先 classify/annotate（此处仅包装）
  const t = tree || dsl?.root && [dsl.root] || domDump?.tree || []

  const typographyProfile = extractTypographyProfile(t)
  const assets = extractAssets(t, styles || dsl?.styles)
  const palette = extractPalette(t, styles)
  const regions = buildRegions(t, c)
  const viewports = viewport ? [viewport] : [{ name: 'desktop', width: c.width, height: c.height }]
  const states = ['default']

  return {
    canvas: c,
    tree: t,
    typographyProfile,
    palette,
    assets,
    regions,
    viewports,
    states,
    meta: { createdAt: new Date().toISOString(), source: dsl ? 'dsl' : domDump ? 'url' : screenshotPaths ? 'screenshot' : 'unknown' },
  }
}

function extractPalette(tree, styles) {
  const colors=[]
  const walk=(nodes)=>{
    for(const n of nodes){
      const cands=[n._color, n.textColor, n.fill, n.computed?.color, n.computed?.backgroundColor, n.computed?.borderColor]
      for(const s of cands){ if(s && typeof s==='string' && s.startsWith('#')) colors.push(s.toLowerCase()) }
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree)?tree:[tree])
  if (styles) {
    for(const v of Object.values(styles) as any[]){
      const val = v?.value
      if (typeof val==='string' && val.startsWith('#')) colors.push(val.toLowerCase())
      if (Array.isArray(val) && typeof val[0]==='string' && val[0].startsWith('#')) colors.push(val[0].toLowerCase())
    }
  }
  // 去重取前 12
  const freq=new Map()
  for(const c of colors) freq.set(c,(freq.get(c)||0)+1)
  return [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([hex,count])=>({hex,count}))
}

// 供 ui-reverse-agent 感知层复用的 DSL→标注树封装
export async function blueprintFromDsl({ dsl, classifyFn, annotateFn, cleanFn }) {
  // 尝试多种 DSL 形态
  // 1. 已为标准 DSL（有 root）
  if (dsl?.root) {
    return buildBlueprint({ canvas: dsl.meta?.canvas, tree: [dsl.root], styles: dsl.styles, dsl })
  }
  // 2. MasterGo 原始 DSL（有 styles/nodes）
  if (dsl?.nodes && classifyFn) {
    const cls = classifyFn(dsl)
    const tree = cls.tree || []
    return buildBlueprint({ canvas: { width: dsl.nodes[0]?.layoutStyle?.width || 1440, height: 900 }, tree, styles: dsl.styles, dsl })
  }
  // 3. 拍平稿 sections
  if (Array.isArray(dsl) && cleanFn) {
    const cleaned = cleanFn({ canvas: { width: 375, height: 812 }, sections: dsl })
    return buildBlueprint({ canvas: cleaned.meta.canvas, tree: [cleaned.root], styles: cleaned.styles, dsl: cleaned })
  }
  return buildBlueprint({ tree: [], styles: {} })
}
