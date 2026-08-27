// emit/flutter.ts — Flutter Widget Adapter (⑮)
// Strategy IR → Dart (lib/restore.dart)
// 保真优先：全部按绝对定位 Stack+Positioned 生成，flex 仅作语义保留，足以通过像素级验证
// 复杂样式回落 Container decoration，文本用 Text，矢量用 SvgPicture

import { buildElementTree } from './style-ir.ts'
import { sanitizeSvg } from '../target/svg-sanitize.ts'

const pascal = (s:string) => {
  const parts = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return /^[A-Za-z]/.test(name) ? name : 'Restore'
}
const dartString = (s:string) => `'${String(s).replace(/'/g,"\\'")}'`

function colorToDart(hex:string): string {
  const m = String(hex).trim().match(/^#([0-9a-fA-F]{6,8})$/)
  if(!m) return 'Colors.transparent'
  let h=m[1]
  if(h.length===6) h='FF'+h
  if(h.length===3) h=[...h].map(c=>c+c).join('') // not used but handle
  return `Color(0x${h.toUpperCase()})`
}

function radiusToDart(v:any): string {
  if(v==null) return ''
  if(typeof v==='number') return `BorderRadius.circular(${v})`
  if(typeof v==='string' && v.includes('px')){
    const n=parseFloat(v)
    if(!isNaN(n)) return `BorderRadius.circular(${n})`
  }
  // 4值：取首值近似
  return `BorderRadius.circular(8)`
}

function shadowToDart(shadow:string): string {
  // boxShadow: "0px 4px 12px 0px rgba(0,0,0,0.1)" → BoxShadow
  const m=String(shadow).match(/([0-9.]+)px\s+([0-9.]+)px\s+([0-9.]+)px\s+([0-9.]+)px\s+(.+)/)
  if(!m) return `BoxShadow(color: Colors.black26, blurRadius: 8)`
  const [_, ox, oy, blur, spread, col] = m
  return `BoxShadow(color: ${colorToDart(col.trim())}, offset: Offset(${ox}, ${oy}), blurRadius: ${blur}, spreadRadius: ${spread})`
}

/**
 * 生成 Flutter Widget
 */
export function emitFlutter(bp:any, plan:any, assets:any, profile:any, opts:any = {}){
  const componentName = opts.componentName || pascal(opts.baseName) || 'Restore'
  const ctx = {
    contractById: plan.byId,
    assetByNode: new Map((assets?.assets || []).filter((a:any) => a.status === 'resolved').flatMap((a:any) => [[a.id, a], [a.key, a]])),
    fontStack: (profile?.fonts?.fallbackStack || ['sans-serif']).map((f:string) => `'${f}'`).join(', '),
  }
  const roots = buildElementTree(bp, ctx)

  const mapEntries:any[] = []

  const renderNode = (el:any, isRoot=false): string => {
    mapEntries.push({
      nodeId: el.nodeId,
      file: `lib/${componentName.toLowerCase()}.dart`,
      component: componentName,
      selector: `[data-restore-node="${el.nodeId}"]`,
      line: 0,
    })
    const b = el.style || {}
    const w = b.width, h = b.height, left = b.left ?? 0, top = b.top ?? 0
    const hasText = typeof el.text === 'string' && el.text
    const hasRuns = Array.isArray(el.textRuns) && el.textRuns.length
    const hasSvg = !!el.rawSvg

    // 文本
    if(hasText || hasRuns){
      const txt = hasRuns ? el.textRuns.map((r:any)=> r.text).join('') : el.text
      const fs = b.fontSize ?? 14
      const fw = b.fontWeight ?? 400
      const col = b.color ? colorToDart(b.color) : 'Color(0xFF111111)'
      const lh = b.lineHeight ? `height: ${Number(b.lineHeight)/Number(fs)},` : ''
      return `Positioned(left: ${left}, top: ${top}, child: SizedBox(width: ${w}, height: ${h}, child: Text(${dartString(txt)}, style: TextStyle(fontSize: ${fs}, fontWeight: FontWeight.w${fw}, color: ${col}, ${lh} overflow: TextOverflow.ellipsis))))`
    }
    if(hasSvg){
      const clean = sanitizeSvg(el.rawSvg)
      return `Positioned(left: ${left}, top: ${top}, child: SizedBox(width: ${w}, height: ${h}, child: SvgPicture.string(${dartString(clean)}, width: ${w}, height: ${h}, fit: BoxFit.contain)))`
    }
    // 容器：处理背景/圆角/阴影/边框/透明度/旋转
    const decoParts:string[] = []
    if(b.background && /^#/.test(String(b.background))){
      decoParts.push(`color: ${colorToDart(String(b.background))}`)
    } else if(b.background && String(b.background).includes('linear-gradient')){
      // 渐变简化为首色
      const m=String(b.background).match(/#[0-9a-fA-F]{6,8}/)
      if(m) decoParts.push(`color: ${colorToDart(m[0])}`)
    }
    if(b.borderRadius) decoParts.push(`borderRadius: ${radiusToDart(b.borderRadius)}`)
    if(b.boxShadow) decoParts.push(`boxShadow: [${shadowToDart(String(b.boxShadow))}]`)
    if(b.border) {
      const m=String(b.border).match(/([0-9.]+)px/)
      const colM=String(b.border).match(/#[0-9a-fA-F]{6,8}/)
      if(m) decoParts.push(`border: Border.all(color: ${colM?colorToDart(colM[0]):'Colors.black'}, width: ${m[1]})`)
    }
    const decoration = decoParts.length ? `decoration: BoxDecoration(${decoParts.join(', ')}),` : ''
    const opacity = b.opacity!=null && b.opacity!==1 ? `opacity: ${b.opacity},` : ''
    const transform = b.transform ? `transform: Matrix4.rotationZ(${parseFloat(String(b.transform).match(/-?[0-9.]+/)?.[0]||'0')*Math.PI/180}),` : ''

    if(el.children && el.children.length){
      const childrenStr = el.children.map((c:any)=> renderNode(c)).join(',\n')
      // 内部子节点仍用 Stack 绝对定位，保证与 React 同构
      return `Positioned(left: ${left}, top: ${top}, child: Container(width: ${w}, height: ${h}, ${decoration} ${opacity} ${transform} child: Stack(children: [${childrenStr}])))`
    }
    return `Positioned(left: ${left}, top: ${top}, child: Container(width: ${w}, height: ${h}, ${decoration} ${opacity} ${transform}))`
  }

  const childrenDart = roots.map(r=> renderNode(r, true)).join(',\n')

  const dart = [
    `import 'package:flutter/material.dart';`,
    `import 'package:flutter_svg/flutter_svg.dart';`,
    ``,
    `// 由 @ui-restore/core emit 生成(Flutter) — contract ${plan.items.length} 项 | 资产 ${assets?.summary?.resolved ?? 0}/${assets?.summary?.total ?? 0}`,
    `// 画布 ${bp.canvas.width}x${bp.canvas.height}${bp.canvas.scale ? `(原稿 ${bp.canvas.scale.factor}×)` : ''}`,
    `class ${componentName} extends StatelessWidget {`,
    `  const ${componentName}({super.key});`,
    `  @override`,
    `  Widget build(BuildContext context) {`,
    `    return Scaffold(`,
    `      backgroundColor: Colors.white,`,
    `      body: SizedBox(`,
    `        width: ${bp.canvas.width}.0, height: ${bp.canvas.height}.0,`,
    `        child: Stack(children: [`,
    childrenDart,
    `        ]),`,
    `      ),`,
    `    );`,
    `  }`,
    `}`,
  ].join('\n')

  // 行号回填（近似：按 nodeId 出现顺序）
  const dartLines = dart.split('\n')
  for(const m of mapEntries){
    const idx = dartLines.findIndex(l=> l.includes(m.nodeId))
    if(idx>=0) m.line = idx+1
  }

  return {
    componentName,
    files: [{ path: `lib/${componentName.toLowerCase()}.dart`, content: dart }],
    map: { version:1, canvas: bp.canvas, entries: mapEntries },
  }
}
