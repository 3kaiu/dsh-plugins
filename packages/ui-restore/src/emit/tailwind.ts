// emit/tailwind.ts — Tailwind serializer (⑰)
// Style IR → Tailwind className + 剩余 inline
// 原则：保真优先，任意值语法 w-[100px] / bg-[#FFF] 保证 1:1，不做近似取整
// 复杂值(gradient/boxShadow 等)回落 inline，避免 Tailwind 无法表达导致的偏差

const UNITLESS_TW = new Set(['opacity','fontWeight','lineHeight','WebkitLineClamp'])

function escArbitrary(v: string){ return String(v).replace(/\s+/g,'_').replace(/"/g,'') }

/** 单条 camelCase style → Tailwind class(es) 或 null(需回落 inline) */
function mapOne(k: string, v: string|number): string[] | null {
  const num = (n:any)=> typeof n==='number' && isFinite(n) ? n : null
  const px = (n:any)=> `${Math.round(Number(n)*100)/100}px`
  switch(k){
    case 'position': return [String(v)] // absolute / relative
    case 'left': return [`left-[${px(v)}]`]
    case 'top': return [`top-[${px(v)}]`]
    case 'right': return [`right-[${px(v)}]`]
    case 'bottom': return [`bottom-[${px(v)}]`]
    case 'width': return [`w-[${px(v)}]`]
    case 'height': return [`h-[${px(v)}]`]
    case 'display': {
      if(v==='flex') return ['flex']
      if(v==='-webkit-box') return null // lineClamp 需 inline
      return [String(v)]
    }
    case 'flexDirection': return v==='row' ? ['flex-row'] : v==='column' ? ['flex-col'] : null
    case 'overflow': return v==='hidden' ? ['overflow-hidden'] : null
    case 'background': {
      const s = String(v).trim()
      if(/^#([0-9a-fA-F]{3,8})$/.test(s)) return [`bg-[${s}]`]
      if(/^rgba?\(/.test(s) || /^hsla?\(/.test(s)) return [`bg-[${escArbitrary(s)}]`]
      // gradient 等复杂值回落 inline
      return null
    }
    case 'backgroundImage': {
      const s=String(v)
      // url(...) → bg-[url(...)]
      if(/^url\(/.test(s)) return [`bg-[${escArbitrary(s)}]`]
      return null
    }
    case 'backgroundSize': return v==='cover' ? ['bg-cover'] : null
    case 'backgroundPosition': return [`bg-[position:${escArbitrary(String(v))}]`]
    case 'backgroundRepeat': return v==='no-repeat' ? ['bg-no-repeat'] : null
    case 'borderRadius': {
      const s=String(v).trim()
      // 10px / 10px 20px ... → rounded-[...]
      if(/px/.test(s)) return [`rounded-[${escArbitrary(s)}]`]
      // number 已在 style-ir 转为 px 字符串? 但此处 v 可能是数字
      if(num(v)!=null) return [`rounded-[${px(v)}]`]
      return null
    }
    case 'boxShadow': return [`shadow-[${escArbitrary(String(v))}]`]
    case 'border': {
      // 1px solid #FF0000 → border + border-[#FF0000] + 需 width
      const m=String(v).match(/^\s*([0-9.]+)px\s+(\w+)\s+(.+)\s*$/)
      if(m){
        const w=m[1], style=m[2], col=m[3]
        const cls=[`border-[${w}px]`, `border-${style}`]
        if(/^#/.test(col) || /^rgba?\(/.test(col)) cls.push(`border-[${col}]`)
        else cls.push(`border-[${escArbitrary(col)}]`)
        return cls
      }
      return null
    }
    case 'opacity': return [`opacity-[${String(v)}]`]
    case 'transform': {
      const m=String(v).match(/rotate\(\s*(-?[0-9.]+)deg\s*\)/)
      if(m) return [`rotate-[${m[1]}deg]`]
      return null
    }
    case 'marginLeft': return [`ml-[${px(v)}]`]
    case 'marginTop': return [`mt-[${px(v)}]`]
    case 'marginRight': return [`mr-[${px(v)}]`]
    case 'marginBottom': return [`mb-[${px(v)}]`]
    case 'padding': return null // Tailwind padding 需四值展开，暂回落 inline
    case 'fontSize': return [`text-[${px(v)}]`]
    case 'fontWeight': return [`font-[${String(v)}]`]
    case 'lineHeight': {
      // 数值 → leading-[...]
      if(num(v)!=null) return [`leading-[${px(v)}]`]
      return [`leading-[${escArbitrary(String(v))}]`]
    }
    case 'letterSpacing': return [`tracking-[${px(v)}]`]
    case 'color': {
      const s=String(v).trim()
      if(/^#/.test(s) || /^rgba?\(/.test(s)) return [`text-[${s}]`]
      return null
    }
    case 'textAlign': {
      if(v==='center') return ['text-center']
      if(v==='left') return ['text-left']
      if(v==='right') return ['text-right']
      if(v==='justify') return ['text-justify']
      return null
    }
    case 'fontFamily': {
      // 复杂栈回落 inline，简单单字体可用 font-['...']
      const s=String(v)
      if(s.includes(',')) return null
      return [`font-['${s.replace(/'/g,'')}']`]
    }
    case 'whiteSpace': return v==='nowrap' ? ['whitespace-nowrap'] : v==='normal' ? ['whitespace-normal'] : null
    case 'wordBreak': return v==='break-all' ? ['break-all'] : null
    case 'WebkitBoxOrient': return null
    case 'WebkitLineClamp': return null
    case 'zIndex': return [`z-[${String(v)}]`]
    default: return null
  }
}

export function styleToTailwind(style: Record<string, string|number>): { className: string; inline: Record<string,string|number> }{
  const classes: string[] = []
  const inline: Record<string,string|number> = {}
  for(const [k,raw] of Object.entries(style)){
    if(raw==null || raw==='') continue
    const mapped = mapOne(k, raw as any)
    if(mapped && mapped.length){
      classes.push(...mapped)
    }else{
      // 无法 Tailwind 化 → 回落 inline
      inline[k]=raw as any
    }
  }
  return { className: classes.join(' '), inline }
}

/** Tailwind 序列化：与 style-ir.buildElementTree 同源，仅样式表达不同 */
import { buildElementTree } from './style-ir.ts'

const safeIdent = (s:string, prefix:string) => prefix + '_' + String(s).replace(/[^a-zA-Z0-9]/g, '_')
const pascal = (s:string) => {
  const parts = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return /^[A-Za-z]/.test(name) ? name : 'Restore' + (name || '')
}
const esc = (s:string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const jsxStyleObject = (style: Record<string, any>) => '{ ' + Object.entries(style)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `${k}: ${typeof v === 'number' ? JSON.stringify(v) : JSON.stringify(String(v))}`)
  .join(', ') + ' }'

/**
 * 生成 Tailwind 版 React 组件源码 + DOM Map
 * 策略：Style IR → styleToTailwind → className + 剩余 inline style
 * 复杂值(gradient/lineClamp 等)自动回落 inline，保真不降
 */
export function emitTailwindReact(bp:any, plan:any, assets:any, profile:any, opts:any = {}){
  const componentName = opts.componentName || pascal(opts.baseName) || 'Restore'
  const ctx = {
    contractById: plan.byId,
    assetByNode: new Map((assets?.assets || []).filter((a:any) => a.status === 'resolved').flatMap((a:any) => [[a.id, a], [a.key, a]])),
    fontStack: (profile?.fonts?.fallbackStack || ['sans-serif']).map((f:string) => `'${f}'`).join(', '),
  }
  const roots = buildElementTree(bp, ctx)
  // ⑱ library 标注
  const annotateLibrary = (el:any)=>{
    const c = ctx.contractById.get(el.nodeId)
    if(c?.component?.strategy==='library' && c.component.name){
      el.library = { component: c.component.name, props: (c as any)._library?.props || {}, importFrom: (c as any)._library?.importFrom || profile.componentLibraries?.[0] || 'antd' }
    }
    for(const ch of el.children||[]) annotateLibrary(ch)
  }
  roots.forEach(annotateLibrary)
  const libraryImports = new Map<string, any>()
  const collectLib = (el:any)=>{ if(el.library){ const k=`${el.library.importFrom}:${el.library.component}`; if(!libraryImports.has(k)) libraryImports.set(k, el.library)} for(const ch of el.children||[]) collectLib(ch) }
  roots.forEach(collectLib)

  // 转换每个节点的 style 为 Tailwind
  const convert = (el:any)=>{
    const { className, inline } = styleToTailwind(el.style || {})
    el.className = className
    el.style = inline
    if(Array.isArray(el.children)) el.children.forEach(convert)
    if(Array.isArray(el.textRuns)){
      for(const r of el.textRuns){
        const tw = styleToTailwind(r.style || {})
        r.className = tw.className
        r.style = tw.inline
      }
    }
  }
  roots.forEach(convert)

  const mapEntries:any[] = []
  const decls:string[] = []
  const jsx:string[] = []

  const collect = (el:any) => {
    if(el.className) decls.push(`  const ${safeIdent(el.nodeId,'cls')} = ${JSON.stringify(el.className)};`)
    if(Object.keys(el.style||{}).length) decls.push(`  const ${safeIdent(el.nodeId,'s')} = ${jsxStyleObject(el.style)};`)
    if (el.rawSvg) decls.push(`  const ${safeIdent(el.nodeId, 'svg')} = ${JSON.stringify(el.rawSvg)};`)
    for (const c of el.children) collect(c)
  }
  for (const el of roots) collect(el)

  const render = (el:any, indent:number) => {
    const pad = ' '.repeat(indent)
    const clsVar = el.className ? safeIdent(el.nodeId,'cls') : null
    const styleVar = Object.keys(el.style||{}).length ? safeIdent(el.nodeId,'s') : null
    const attrs = [`data-restore-node="${el.nodeId}"`]
    if (el.assetMissing) attrs.push(`data-asset-missing="${esc(el.assetMissing)}"`)
    const tag = el.library ? el.library.component : 'div'
    const extraProps = el.library && el.library.props ? Object.entries(el.library.props).map(([k,v])=> ` ${k}={${JSON.stringify(v)}}`).join('') : ''
    const clsAttr = clsVar ? ` className={${clsVar}}` : ''
    const styleAttr = styleVar ? ` style={${styleVar}}` : ''
    const open = `${pad}<${tag} ${attrs.join(' ')}${extraProps}${clsAttr}${styleAttr}>`
    const closeTag = `</${tag}>`
    const selfText = el.text != null && !el.textRuns?.length ? `{${JSON.stringify(el.text)}}` : ''
    if (selfText) {
      jsx.push(`${open}${selfText}${closeTag}`)
      mapEntries.push(entry(el, jsx.length, clsVar, styleVar))
      return
    }
    jsx.push(open)
    mapEntries.push(entry(el, jsx.length, clsVar, styleVar))
    if (el.rawSvg) {
      jsx.push(`${pad}  <div className="w-full h-full" dangerouslySetInnerHTML={{ __html: ${safeIdent(el.nodeId, 'svg')} }} />`)
    }
    if (el.textRuns?.length) {
      for (const r of el.textRuns){
        const rc = (r as any).className ? ` className=${JSON.stringify((r as any).className)}` : ''
        const rs = Object.keys(r.style||{}).length ? ` style={${jsxStyleObject(r.style)}}` : ''
        jsx.push(`${pad}  <span${rc}${rs}>${esc(r.text)}</span>`)
      }
    }
    for (const c of el.children) render(c, indent + 2)
    jsx.push(`${pad}${closeTag}`)
  }
  const entry = (el:any, line:number, clsVar:string|null, styleVar:string|null) => ({
    nodeId: el.nodeId,
    file: `src/${componentName}.tsx`,
    component: componentName,
    selector: `[data-restore-node="${el.nodeId}"]`,
    line,
    attributes: { 'data-restore-node': el.nodeId, ...(clsVar?{className:clsVar}:{}), ...(styleVar?{style:styleVar}:{}) },
  })

  for (const el of roots) render(el, 6)
  const canvasTw = styleToTailwind({
    position: 'relative',
    width: bp.canvas.width,
    height: bp.canvas.height,
    overflow: 'hidden',
    background: '#FFFFFF',
  })
  const canvasInline = { fontFamily: ctx.fontStack }
  const importLines = [...libraryImports.values()].map((li:any)=> `import { ${li.component} } from '${li.importFrom}';`)
  const content = [
    `// 由 @ui-restore/core emit 生成(Tailwind) — 受 Generation Contract 约束`,
    `// 画布 ${bp.canvas.width}x${bp.canvas.height}${bp.canvas.scale ? `(原稿 ${bp.canvas.scale.factor}×)` : ''} | contract ${plan.items.length} 项 | 资产 ${assets?.summary?.resolved ?? 0}/${assets?.summary?.total ?? 0} | Tailwind 任意值保真${libraryImports.size?` | 库组件 ${[...libraryImports.values()].map((l:any)=>l.component).join(',')}`:''}`,
    ...importLines,
    `export default function ${componentName}() {`,
    `  const pageCls = ${JSON.stringify(canvasTw.className)};`,
    `  const pageStyle = ${jsxStyleObject(canvasInline)};`,
    ...decls.map((l) => l),
    '  return (',
    '    <div data-restore-root className={pageCls} style={pageStyle}>',
    ...jsx,
    '    </div>',
    '  )',
    '}',
  ].join('\n')
  const contentLines = content.split('\n')
  for (const m of mapEntries) {
    const idx = contentLines.findIndex((l) => l.includes(`data-restore-node="${m.nodeId}"`))
    if (idx >= 0) m.line = idx + 1
  }
  return {
    componentName,
    files: [{ path: `src/${componentName}.tsx`, content }],
    map: { version: 1, canvas: bp.canvas, entries: mapEntries },
    stats: { mode: 'tailwind', tailwindClasses: content.match(/className/g)?.length ?? 0 },
  }
}
