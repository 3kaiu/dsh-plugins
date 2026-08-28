// emit/vue.ts — Vue 3 SFC Adapter (⑭)
// Strategy IR → .vue SFC (template + script setup)
// 与 React 同源（buildElementTree），仅语法层差异：:style 绑定、data-restore-node 保留、DOM Map 同构

import { buildElementTree, styleToCssDeclarations } from './style-ir.ts'
import { sanitizeSvg } from '../target/svg-sanitize.ts'
import { esc, escAttr } from './escape.ts'

const pascal = (s:string) => {
  const parts = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return /^[A-Za-z]/.test(name) ? name : 'Restore' + (name || '')
}
/** 生成安全的 Vue v-html 绑定字面量: 外层单引号属性, 内层 JSON 双引号字符串, 单引号转义(防反斜杠/换行/引号击穿属性) */
const vueSvgLiteral = (svg:string) => `'${JSON.stringify(sanitizeSvg(svg)).replace(/'/g, "\\'")}'`

const UNITLESS = new Set(['opacity','zIndex','fontWeight','lineHeight','flexGrow','flexShrink','order','WebkitLineClamp'])
function styleObjectToVueBinding(style: Record<string, any>): string {
  const entries = Object.entries(style).filter(([,v])=> v!=null && v!=='')
  if(!entries.length) return ''
  const obj = entries.map(([k,v])=> {
    let val = v
    if(typeof v==='number' && !UNITLESS.has(k)) val = `${v}px`
    return `${k}: ${JSON.stringify(String(val))}`
  }).join(', ')
  return `:style="{ ${obj} }"`
}

/**
 * 生成 Vue SFC + DOM Map
 */
export function emitVue(bp:any, plan:any, assets:any, profile:any, opts:any = {}){
  const componentName = opts.componentName || pascal(opts.baseName) || 'RestoreVue'
  const ctx = {
    contractById: plan.byId,
    assetByNode: new Map((assets?.assets || []).filter((a:any) => a.status === 'resolved').flatMap((a:any) => [[a.id, a], [a.key, a]])),
    fontStack: (profile?.fonts?.fallbackStack || ['sans-serif']).map((f:string) => `'${f}'`).join(', '),
  }
  const roots = buildElementTree(bp, ctx)

  // ⑱ library 标注（Vue 生态：element-plus / arco）
  const annotateLibrary = (el:any)=>{
    const c = ctx.contractById.get(el.nodeId)
    if(c?.component?.strategy==='library' && c.component.name){
      // Vue 下库组件名保持，但 import 来源按 profile
      const lib = (c as any)._library
      el.library = { component: c.component.name, props: lib?.props || {}, importFrom: lib?.importFrom || profile.componentLibraries?.[0] || 'element-plus' }
    }
    for(const ch of el.children||[]) annotateLibrary(ch)
  }
  roots.forEach(annotateLibrary)
  const libraryImports = new Map<string, any>()
  const collectLib = (el:any)=>{ if(el.library){ const k=`${el.library.importFrom}:${el.library.component}`; if(!libraryImports.has(k)) libraryImports.set(k, el.library)} for(const ch of el.children||[]) collectLib(ch) }
  roots.forEach(collectLib)

  const mapEntries:any[] = []
  const entry = (el:any, line:number)=>({
    nodeId: el.nodeId,
    file: `src/${componentName}.vue`,
    component: componentName,
    selector: `[data-restore-node="${el.nodeId}"]`,
    line,
    attributes: { 'data-restore-node': el.nodeId },
  })

  // canvas 根
  const canvasStyle = {
    position: 'relative',
    width: bp.canvas.width,
    height: bp.canvas.height,
    overflow: 'hidden',
    background: '#FFFFFF',
    fontFamily: ctx.fontStack,
  }
  const canvasBinding = styleObjectToVueBinding(canvasStyle)

  // 生成 SFC — 用 tmpLines 收集
  const tmpLines:string[] = []
  const renderWithTmp = (el:any, indent:number)=>{
    const pad = ' '.repeat(indent)
    const styleBinding = styleObjectToVueBinding(el.style || {})
    const attrs = [`data-restore-node="${escAttr(el.nodeId)}"`]
    if(el.assetMissing) attrs.push(`data-asset-missing="${escAttr(el.assetMissing)}"`)
    const tag = el.library ? el.library.component : 'div'
    const extraProps = el.library && el.library.props ? Object.entries(el.library.props).map(([k,v])=> ` ${k}="${escAttr(String(v))}"`).join('') : ''
    const styleAttr = styleBinding ? ` ${styleBinding}` : ''
    const open = `${pad}<${tag} ${attrs.join(' ')}${extraProps}${styleAttr}>`
    const isLeafText = el.text != null && !el.textRuns?.length
    if(isLeafText){
      tmpLines.push(`${open}${esc(el.text)}</${tag}>`)
      mapEntries.push(entry(el, tmpLines.length))
      return
    }
    tmpLines.push(open)
    mapEntries.push(entry(el, tmpLines.length))
    if(el.rawSvg){
      tmpLines.push(`${pad}  <div style="width:100%;height:100%" v-html=${vueSvgLiteral(el.rawSvg)}></div>`)
    }
    if(el.textRuns?.length){
      for(const r of el.textRuns){
        const rs = styleObjectToVueBinding(r.style || {})
        const attr = rs ? ` ${rs}` : ''
        tmpLines.push(`${pad}  <span${attr}>${esc(r.text)}</span>`)
      }
    }
    for(const c of el.children) renderWithTmp(c, indent+2)
    tmpLines.push(`${pad}</${tag}>`)
  }
  for(const el of roots) renderWithTmp(el, 4)

  const imports = [...libraryImports.values()].map(li=> `import { ${li.component} } from '${li.importFrom}';`).join('\n')

  const sfc = [
    `<template>`,
    `  <div data-restore-root ${canvasBinding}>`,
    ...tmpLines,
    `  </div>`,
    `</template>`,
    ``,
    `<script setup lang="ts">`,
    imports ? imports : `// 由 @ui-restore/core emit 生成(Vue) — contract ${plan.items.length} 项 | 资产 ${assets?.summary?.resolved ?? 0}/${assets?.summary?.total ?? 0}${libraryImports.size?` | 库组件 ${[...libraryImports.values()].map(l=>l.component).join(',')}`:''}`,
    `</script>`,
    ``,
    `<style scoped>`,
    `/* 画布 ${bp.canvas.width}x${bp.canvas.height}${bp.canvas.scale ? `(原稿 ${bp.canvas.scale.factor}×)` : ''} */`,
    `</style>`,
  ].join('\n')

  // 行号回填：按 SFC 行号
  const sfcLines = sfc.split('\n')
  for(const m of mapEntries){
    const idx = sfcLines.findIndex(l=> l.includes(`data-restore-node="${m.nodeId}"`))
    if(idx>=0) m.line = idx+1
  }

  return {
    componentName,
    files: [{ path: `src/${componentName}.vue`, content: sfc }],
    map: { version:1, canvas: bp.canvas, entries: mapEntries },
  }
}
