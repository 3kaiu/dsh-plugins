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
  const s = String(hex).trim()
  let m = s.match(/^#([0-9a-fA-F]{3,8})$/)
  if (m) {
    let h = m[1]
    if (h.length === 3) h = [...h].map((c) => c + c).join('')
    if (h.length === 6) h = 'FF' + h
    return `Color(0x${h.toUpperCase()})`
  }
  m = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/)
  if (m) {
    const a = m[4] != null ? m[4] : '1'
    return `Color.fromRGBO(${m[1]}, ${m[2]}, ${m[3]}, ${a})`
  }
  return 'Colors.transparent'
}

/** font-weight → Flutter FontWeight（数值归到 100 倍数；bold/lighter 等命名映射） */
function fontWeightToDart(fw:any): string {
  if (typeof fw === 'number') {
    const n = Math.min(900, Math.max(100, Math.round(fw / 100) * 100))
    return `FontWeight.w${n}`
  }
  if (typeof fw === 'string') {
    const map: Record<string, string> = { normal: 'w400', regular: 'w400', bold: 'w700', bolder: 'w700', lighter: 'w300', medium: 'w500' }
    if (map[fw]) return `FontWeight.${map[fw]}`
    const n = parseInt(fw, 10)
    if (!isNaN(n)) {
      const c = Math.min(900, Math.max(100, Math.round(n / 100) * 100))
      return `FontWeight.w${c}`
    }
  }
  return 'FontWeight.w400'
}

function radiusToDart(v:any): string {
  if (v == null) return ''
  if (typeof v === 'number') return `BorderRadius.circular(${v})`
  if (typeof v === 'string') {
    const parts = String(v).split(/\s+/).map((p) => parseFloat(p)).filter((n) => !isNaN(n))
    if (parts.length === 1) return `BorderRadius.circular(${parts[0]})`
    if (parts.length >= 2) {
      const [tl, tr, br, bl] = parts.length >= 4 ? [parts[0], parts[1], parts[2], parts[3]] : [parts[0], parts[1], parts[0], parts[1]]
      return `BorderRadius.only(topLeft: Radius.circular(${tl}), topRight: Radius.circular(${tr}), bottomRight: Radius.circular(${br}), bottomLeft: Radius.circular(${bl}))`
    }
    const n = parseFloat(v)
    if (!isNaN(n)) return `BorderRadius.circular(${n})`
  }
  return `BorderRadius.circular(8)`
}

function shadowToDart(shadow:string): string {
  // boxShadow: "0px 4px 12px 0px rgba(0,0,0,0.1)" → BoxShadow
  const m = String(shadow).match(/([0-9.]+)px\s+([0-9.]+)px\s+([0-9.]+)px\s+([0-9.]+)px\s+(.+)/)
  if (!m) return `BoxShadow(color: Colors.black26, blurRadius: 8)`
  const [_, ox, oy, blur, spread, col] = m
  return `BoxShadow(color: ${colorToDart(col.trim())}, offset: Offset(${ox}, ${oy}), blurRadius: ${blur}, spreadRadius: ${spread})`
}

/** 解析 linear-gradient CSS → Flutter LinearGradient 参数(角度→Alignment 近似) */
function parseGradient(css:string): string | null {
  const m = String(css).match(/linear-gradient\(\s*([0-9.]+)deg\s*,([\s\S]+)\)/)
  if (!m) return null
  const angle = parseFloat(m[1])
  const stops = m[2].split(',').map((s) => s.trim()).filter(Boolean)
    .map((part) => {
      const mm = part.match(/^(.*?)\s+([0-9.]+)%$/)
      if (mm) return { color: mm[1].trim(), pos: parseFloat(mm[2]) / 100 }
      return { color: part, pos: null }
    }).filter((s) => s.color && (s.pos != null))
  if (!stops.length) return null
  const a = (angle % 360) * Math.PI / 180
  const dx = Math.sin(a), dy = -Math.cos(a)
  const begin = `Alignment(${(-dx).toFixed(3)}, ${(-dy).toFixed(3)})`
  const end = `Alignment(${dx.toFixed(3)}, ${dy.toFixed(3)})`
  const colors = stops.map((s) => colorToDart(s.color)).join(', ')
  const pos = stops.map((s) => s.pos).join(', ')
  return `LinearGradient(begin: ${begin}, end: ${end}, stops: [${pos}], colors: [${colors}])`
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

    // 文本（含富文本 run 颜色/字号/字重）
    if(hasText || hasRuns){
      const fs = b.fontSize ?? 14
      const col = b.color ? colorToDart(b.color) : 'Color(0xFF111111)'
      const fw = fontWeightToDart(b.fontWeight ?? 400)
      const lh = b.lineHeight ? `height: ${Number(b.lineHeight)/Number(fs)},` : ''
      const letter = b.letterSpacing != null ? `letterSpacing: ${Number(b.letterSpacing)},` : ''
      const maxLines = b.WebkitLineClamp != null ? `maxLines: ${b.WebkitLineClamp},` : ''
      const softWrap = b.whiteSpace === 'nowrap' ? `softWrap: false,` : ''
      const txtWidget = hasRuns
        ? `Text.rich(TextSpan(children: [${el.textRuns.map((r:any) => {
            const rstyle = r.style || {}
            const rc = rstyle.color ? colorToDart(rstyle.color) : col
            const rfs = rstyle.fontSize ?? fs
            const rfw = fontWeightToDart(rstyle.fontWeight ?? 400)
            const rls = rstyle.letterSpacing != null ? `letterSpacing: ${Number(rstyle.letterSpacing)},` : ''
            return `TextSpan(text: ${dartString(r.text)}, style: TextStyle(fontSize: ${rfs}, fontWeight: ${rfw}, color: ${rc}, ${rls})`
          }).join(',\n')}], style: TextStyle(fontSize: ${fs}, fontWeight: ${fw}, color: ${col}, ${lh} ${letter} ${maxLines} ${softWrap} overflow: TextOverflow.ellipsis)))`
        : `Text(${dartString(hasRuns ? '' : el.text)}, style: TextStyle(fontSize: ${fs}, fontWeight: ${fw}, color: ${col}, ${lh} ${letter} ${maxLines} ${softWrap} overflow: TextOverflow.ellipsis))`
      return `Positioned(left: ${left}, top: ${top}, child: SizedBox(width: ${w}, height: ${h}, child: ${txtWidget}))`
    }
    if(hasSvg){
      const clean = sanitizeSvg(el.rawSvg)
      return `Positioned(left: ${left}, top: ${top}, child: SizedBox(width: ${w}, height: ${h}, child: SvgPicture.string(${dartString(clean)}, width: ${w}, height: ${h}, fit: BoxFit.contain)))`
    }
    // 容器：背景 / 渐变 / 图片 / 圆角 / 阴影 / 边框
    const decoParts:string[] = []
    if(b.background && /^#/.test(String(b.background))){
      decoParts.push(`color: ${colorToDart(String(b.background))}`)
    } else if(b.background && String(b.background).includes('linear-gradient')){
      const grad = parseGradient(String(b.background))
      if(grad) decoParts.push(`gradient: ${grad}`)
    }
    if(b.backgroundImage){
      const fm = String(b.backgroundImage).match(/url\((['"]?)([^'")]+)\1\)/)
      const imgSrc = fm ? fm[2] : ''
      if(imgSrc){
        const imgExpr = /^https?:\/\//.test(imgSrc) ? `NetworkImage(${dartString(imgSrc)})` : `FileImage(File(${dartString(imgSrc)}))`
        decoParts.push(`image: DecorationImage(image: ${imgExpr}, fit: BoxFit.cover)`)
      }
    }
    if(b.borderRadius) decoParts.push(`borderRadius: ${radiusToDart(b.borderRadius)}`)
    if(b.boxShadow) decoParts.push(`boxShadow: [${shadowToDart(String(b.boxShadow))}]`)
    if(b.border) {
      const m=String(b.border).match(/([0-9.]+)px/)
      const colM=String(b.border).match(/#[0-9a-fA-F]{6,8}/)
      if(m) decoParts.push(`border: Border.all(color: ${colM?colorToDart(colM[0]):'Colors.black'}, width: ${m[1]})`)
    }
    const decoration = decoParts.length ? `decoration: BoxDecoration(${decoParts.join(', ')}),` : ''
    let inner: string
    if(el.children && el.children.length){
      const childrenStr = el.children.map((c:any)=> renderNode(c)).join(',\n')
      inner = `Container(width: ${w}, height: ${h}, ${decoration} child: Stack(children: [${childrenStr}]))`
    } else {
      inner = `Container(width: ${w}, height: ${h}, ${decoration})`
    }
    // 透明度用 Opacity 包裹（仅作用于本容器背景，不污染子代位置）
    let wrapped = inner
    if(b.opacity != null && b.opacity !== 1){
      wrapped = `Opacity(opacity: ${Number(b.opacity)}, child: ${wrapped})`
    }
    // 旋转绕中心(避免默认绕左上角偏移)
    if(b.transform){
      const deg = parseFloat(String(b.transform).match(/-?[0-9.]+/)?.[0] || '0')
      wrapped = `Transform(alignment: Alignment.center, transform: Matrix4.rotationZ(${deg} * 3.141592653589793 / 180), child: ${wrapped})`
    }
    return `Positioned(left: ${left}, top: ${top}, child: ${wrapped})`
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
