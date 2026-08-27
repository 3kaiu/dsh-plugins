// emit/miniprogram.ts — WeChat Mini Program Adapter (⑯)
// Strategy IR → WXML + WXSS + JS + JSON
// rpx: 750rpx = 375px (iPhone6 基准)，所有 px ×2 转 rpx 保证视觉等比

import { buildElementTree, styleToCssDeclarations } from './style-ir.ts'
import { sanitizeSvg } from '../target/svg-sanitize.ts'

const pascal = (s:string) => {
  const parts = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return /^[A-Za-z]/.test(name) ? name : 'Restore'
}
const esc = (s:string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function pxToRpx(v: string|number): string {
  if(typeof v==='number') return `${Math.round(v*2)}rpx`
  const n=parseFloat(String(v))
  if(!isNaN(n) && String(v).includes('px')) return `${Math.round(n*2)}rpx`
  return String(v)
}

function styleToWxss(style: Record<string, any>): string {
  // 复用 styleToCssDeclarations 再 px→rpx
  const decl = styleToCssDeclarations(style)
  return decl.replace(/([0-9.]+)px/g, (_, n)=> `${Math.round(parseFloat(n)*2)}rpx`)
}

export function emitMiniProgram(bp:any, plan:any, assets:any, profile:any, opts:any = {}){
  const componentName = opts.componentName || pascal(opts.baseName) || 'Restore'
  const ctx = {
    contractById: plan.byId,
    assetByNode: new Map((assets?.assets || []).filter((a:any) => a.status === 'resolved').flatMap((a:any) => [[a.id, a], [a.key, a]])),
    fontStack: (profile?.fonts?.fallbackStack || ['sans-serif']).map((f:string) => `'${f}'`).join(', '),
  }
  const roots = buildElementTree(bp, ctx)

  const mapEntries:any[] = []
  const wxmlLines:string[] = []
  const wxssLines:string[] = []

  // 根容器样式
  wxssLines.push(`.restore-root{position:relative;width:${pxToRpx(bp.canvas.width)};height:${pxToRpx(bp.canvas.height)};overflow:hidden;background:#FFFFFF;}`)

  const render = (el:any, indent:number, cls:string)=>{
    const pad=' '.repeat(indent)
    const clsName = `node-${el.nodeId.replace(/[^a-zA-Z0-9]/g,'-')}`
    const style = el.style || {}
    const wxss = styleToWxss(style)
    if(wxss) wxssLines.push(`.${clsName}{${wxss}}`)
    const attrs = [`data-restore-node="${el.nodeId}"`, `class="${clsName}"`]
    if(el.assetMissing) attrs.push(`data-asset-missing="${el.assetMissing}"`)
    const isLeafText = typeof el.text==='string' && el.text && !el.textRuns?.length
    if(isLeafText){
      wxmlLines.push(`${pad}<view ${attrs.join(' ')}>${esc(el.text)}</view>`)
      mapEntries.push({ nodeId: el.nodeId, file: `pages/${componentName.toLowerCase()}/${componentName.toLowerCase()}.wxml`, selector: `[data-restore-node="${el.nodeId}"]`, line: wxmlLines.length })
      return
    }
    wxmlLines.push(`${pad}<view ${attrs.join(' ')}>`)
    mapEntries.push({ nodeId: el.nodeId, file: `pages/${componentName.toLowerCase()}/${componentName.toLowerCase()}.wxml`, selector: `[data-restore-node="${el.nodeId}"]`, line: wxmlLines.length })
    if(el.rawSvg){
      // 小程序不支持内联 SVG，转为 image 占位（仍需消毒校验，防恶意 svgKey 注入）
      const _clean = sanitizeSvg(el.rawSvg)
      void _clean
      wxmlLines.push(`${pad}  <image style="width:100%;height:100%" src="" />`)
    }
    if(el.textRuns?.length){
      for(const r of el.textRuns){
        const rs = styleToWxss(r.style||{})
        const cls2 = `run-${el.nodeId}-${Math.random().toString(36).slice(2,6)}`
        if(rs) wxssLines.push(`.${cls2}{${rs}}`)
        wxmlLines.push(`${pad}  <text class="${cls2}">${esc(r.text)}</text>`)
      }
    }
    for(const c of el.children) render(c, indent+2, clsName)
    wxmlLines.push(`${pad}</view>`)
  }

  // 渲染所有根
  wxmlLines.push(`<view class="restore-root">`)
  for(const r of roots) render(r, 2, 'restore-root')
  wxmlLines.push(`</view>`)

  const wxml = wxmlLines.join('\n')
  const wxss = wxssLines.join('\n')
  const js = `// 由 @ui-restore/core emit 生成(小程序) — contract ${plan.items.length} 项\nPage({ data: {}, onLoad(){} })`
  const json = JSON.stringify({ navigationBarTitleText: componentName, usingComponents: {} }, null, 1)
  const base = `pages/${componentName.toLowerCase()}`
  return {
    componentName,
    files: [
      { path: `${base}/${componentName.toLowerCase()}.wxml`, content: wxml },
      { path: `${base}/${componentName.toLowerCase()}.wxss`, content: wxss },
      { path: `${base}/${componentName.toLowerCase()}.js`, content: js },
      { path: `${base}/${componentName.toLowerCase()}.json`, content: json },
    ],
    map: { version:1, canvas: bp.canvas, entries: mapEntries },
  }
}
