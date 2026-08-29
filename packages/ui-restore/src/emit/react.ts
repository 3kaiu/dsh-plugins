// emit/react.ts — React Adapter(V1 唯一验证载体, 非架构限制)
//
// Strategy IR → Restore.tsx(内联样式 = styling unknown 的安全路径) + .restore-map.json(P0-4)。
// 按 contract.layout.strategy 输出 —— 绝对/flex 跟随 contract, 不跟随裸 layout.role。
// 结构分两遍: 先遍历 IR 产出样式常量声明, 再遍历产出 JSX(行号据此回填 restore-map)。
import { buildElementTree } from './style-ir.ts'
import { sanitizeSvg } from '../target/svg-sanitize.ts'
import { esc } from './escape.ts'

const safeIdent = (s, prefix) => prefix + '_' + String(s).replace(/[^a-zA-Z0-9]/g, '_')
const pascal = (s) => {
  const parts = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return /^[A-Za-z]/.test(name) ? name : 'Restore' + (name || '')
}
const jsxStyleObject = (style) => '{ ' + Object.entries(style)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `${k}: ${typeof v === 'number' ? JSON.stringify(v) : JSON.stringify(String(v))}`)
  .join(', ') + ' }'

/**
 * 生成 React 组件源码 + DOM Map。
 * @param {object} bp 蓝图
 * @param {object} plan planGeneration 输出
 * @param {object} assets resolveAssets 输出
 * @param {object} profile Target Profile
 * @param {object} [opts] {componentName?, baseName?}
 * @returns {{componentName, files:{path,content}[], map}}
 */
export function emitReact(bp, plan, assets, profile, opts: Record<string, any> = {}) {
  const componentName = opts.componentName || pascal(opts.baseName) || 'Restore'
  const ctx = {
    contractById: plan.byId,
    assetByNode: new Map((assets?.assets || []).filter((a) => a.status === 'resolved').flatMap((a) => [[a.id, a], [a.key, a]])),
    fontStack: (profile?.fonts?.fallbackStack || ['sans-serif']).map((f) => `'${f}'`).join(', '),
  }
  const roots = buildElementTree(bp, ctx)
  // ⑱ library 标注：按 contract 回填库组件标签
  const annotateLibrary = (el)=>{
    const c = ctx.contractById.get(el.nodeId)
    if(c?.component?.strategy==='library' && c.component.name){
      el.library = { component: c.component.name, props: (c as any)._library?.props || {}, importFrom: (c as any)._library?.importFrom || profile.componentLibraries?.[0] || 'antd' }
    }
    for(const ch of el.children||[]) annotateLibrary(ch)
  }
  roots.forEach(annotateLibrary)
  const libraryImports = new Map()
  const collectImports = (el)=>{
    if(el.library) {
      const key = `${el.library.importFrom}:${el.library.component}`
      if(!libraryImports.has(key)) libraryImports.set(key, el.library)
    }
    for(const ch of el.children||[]) collectImports(ch)
  }
  roots.forEach(collectImports)

  const mapEntries = []
  const decls = []
  const jsx = []

  const collect = (el) => {
    const styleVar = safeIdent(el.nodeId, 's')
    decls.push(`  const ${styleVar} = ${jsxStyleObject(el.style)};`)
    if (el.rawSvg) {
      const clean = sanitizeSvg(el.rawSvg)
      decls.push(`  const ${safeIdent(el.nodeId, 'svg')} = ${JSON.stringify(clean)};`)
    }
    for (const c of el.children) collect(c)
  }
  for (const el of roots) collect(el)

  const render = (el, indent) => {
    const pad = ' '.repeat(indent)
    const styleVar = safeIdent(el.nodeId, 's')
    const attrs = [`data-restore-node="${el.nodeId}"`]
    if (el.assetMissing) attrs.push(`data-asset-missing="${esc(el.assetMissing)}"`)
    const tag = el.library ? el.library.component : 'div'
    const extraProps = el.library && el.library.props ? Object.entries(el.library.props).map(([k,v])=> ` ${k}={${JSON.stringify(v)}}`).join('') : ''
    const open = `${pad}<${tag} ${attrs.join(' ')}${extraProps} style={${styleVar}}>`
    const closeTag = `</${tag}>`
    const selfText = el.text != null && !el.textRuns?.length ? `{${JSON.stringify(el.text)}}` : ''
    if (selfText) {
      jsx.push(`${open}${selfText}${closeTag}`)
      mapEntries.push(entry(el, jsx.length, styleVar))
      return
    }
    jsx.push(open)
    mapEntries.push(entry(el, jsx.length, styleVar))
    if (el.rawSvg) {
      jsx.push(`${pad}  <div style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: ${safeIdent(el.nodeId, 'svg')} }} />`)
    }
    if (el.textRuns?.length) {
      for (const r of el.textRuns) jsx.push(`${pad}  <span style={${jsxStyleObject(r.style)}}>${esc(r.text)}</span>`)
    }
    for (const c of el.children) render(c, indent + 2)
    jsx.push(`${pad}${closeTag}`)
  }
  const entry = (el, line, styleVar) => ({
    nodeId: el.nodeId,
    file: `src/${componentName}.tsx`,
    component: componentName,
    selector: `[data-restore-node="${el.nodeId}"]`,
    line,
    attributes: { 'data-restore-node': el.nodeId, style: styleVar },
  })

  for (const el of roots) render(el, 6)
  const canvasStyle = {
    position: 'relative',
    width: bp.canvas.width,
    height: bp.canvas.height,
    overflow: 'hidden',
    background: '#FFFFFF',
    fontFamily: ctx.fontStack,
  }
  const importLines = [...libraryImports.values()].map(li=> `import { ${li.component} } from '${li.importFrom}';`)
  const content = [
    `// 由 @ui-restore/core emit 生成(确定性) — 直接手改会被 generate 覆盖, 修复走 Patch Contract(allowedNodes 限定)`,
    `// 画布 ${bp.canvas.width}x${bp.canvas.height}${bp.canvas.scale ? `(原稿 ${bp.canvas.scale.factor}×)` : ''} | contract ${plan.items.length} 项 | 资产 ${assets?.summary?.resolved ?? 0}/${assets?.summary?.total ?? 0}${libraryImports.size?` | 库组件 ${[...libraryImports.values()].map(l=>l.component).join(',')}`:''}`,
    ...importLines,
    `export default function ${componentName}() {`,
    `  const page = ${jsxStyleObject(canvasStyle)};`,
    ...decls.map((l) => l),
    '  return (',
    '    <div data-restore-root style={page}>',
    ...jsx,
    '    </div>',
    '  )',
    '}',
  ].join('\n')
  // 行号回填: map.line = JSX 行实际所在行(decls+头占位偏移)
  const contentLines = content.split('\n')
  for (const m of mapEntries) {
    const idx = contentLines.findIndex((l) => l.includes(`data-restore-node="${m.nodeId}"`))
    if (idx >= 0) m.line = idx + 1
  }
  return {
    componentName,
    files: [{ path: `src/${componentName}.tsx`, content }],
    map: { version: 1, canvas: bp.canvas, entries: mapEntries },
  }
}
