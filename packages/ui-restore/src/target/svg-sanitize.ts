// target/svg-sanitize.ts — SVG 白名单消毒（P1 安全深化）
// 仅允许 svg/g/path/circle/rect/line/polyline/polygon/ellipse/use/defs/clipPath/mask
// 禁止 script、事件属性(on*), javascript:、data:text/html 外链、style 表达式、实体编码绕过

const ALLOWED_TAGS = new Set(['svg','g','path','circle','rect','line','polyline','polygon','ellipse','use','defs','clipPath','mask','linearGradient','radialGradient','stop','filter','feGaussianBlur','feOffset','feComposite','feBlend','feColorMatrix'])
const ALLOWED_ATTRS = new Set(['d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','opacity','transform','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','points','href','xlink:href','gradientUnits','gradientTransform','offset','stop-color','stop-opacity','flood-color','flood-opacity','stdDeviation','dx','dy','in','in2','result','operator','type','values','color','fill-opacity','stroke-opacity','xmlns','xmlns:xlink','id','clip-path','mask'])

/** 解码数值实体 &#x6A; / &#106; → 字符，防 javascript: 编码绕过 */
function decodeEntities(s: string): string {
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h)=> String.fromCharCode(parseInt(h,16))).replace(/&#([0-9]+);/g, (_, d)=> String.fromCharCode(parseInt(d,10))).replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&amp;/gi,'&')
}
const DANGEROUS_URL_RE = /(?:javascript\s*:|data\s*:\s*text\/html|vbscript\s*:)/i
const STYLE_URL_RE = /expression\s*\(|url\s*\(\s*['"]?\s*javascript/i

/**
 * 白名单消毒：字符串级过滤，无需 DOMParser（Node 环境零依赖）
 * 策略：移除 script 块、on* 事件、javascript:/data:text/html、style 表达式；实体解码后二次校验
 */
export function sanitizeSvg(svg: string): string {
  if(!svg || typeof svg!=='string') return ''
  let out = svg
  // 1. 移除 script 块（含大小写与属性）
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '')
  // 2. 移除事件属性：需覆盖 <svg/onload=...> 这种斜杠后无空格的写法
  out = out.replace(/[\s\/]+on\w+\s*=\s*(['"]).*?\1/gi, '')
  out = out.replace(/[\s\/]+on\w+\s*=\s*[^\s"'`>]+/gi, '')
  // 3. 危险协议不在此全局剥离，留给逐属性白名单丢弃（避免把 href="javascript:..." 截成 href="alert(1)" 仍保留）
  // 仅对文本节点中的残留做最终兜底（在标签处理后）
  // 4. 仅保留允许标签：逐标签检查（含自闭合 <path .../>）
  out = out.replace(/<\/?([a-zA-Z0-9:]+)(\s[^>]*?)?\s*\/?>/g, (m, tag, attrs)=>{
    const t = String(tag).toLowerCase().split(':').pop() || ''
    const isClose = m.startsWith('</')
    const isSelfClose = /\/\s*>$/.test(m)
    if(!ALLOWED_TAGS.has(t)){
      if(t==='svg') return m
      // 非白名单：剥离标签，保留文本内容；foreignObject/html/body 等连同内层 HTML 一并剥离标签但保留文本
      return ''
    }
    if(isClose) return `</${tag}>`
    if(!attrs) return isSelfClose ? `<${tag}/>` : `<${tag}>`
    const kept: string[] = []
    const attrRe = /([a-zA-Z0-9:_\-]+)\s*=\s*(['"])(.*?)\2/g
    let am: RegExpExecArray | null
    while((am = attrRe.exec(attrs))){
      let k = am[1].toLowerCase()
      let v = am[3]
      // 属性名白名单
      if(!ALLOWED_ATTRS.has(k) && !k.startsWith('data-')) continue
      // style 属性整体禁止（即使在白名单外，但显式拦截）
      if(k==='style') continue
      // 解码后检查属性值
      const dv = decodeEntities(v)
      if(DANGEROUS_URL_RE.test(dv) || STYLE_URL_RE.test(dv)) continue
      if(DANGEROUS_URL_RE.test(v) || STYLE_URL_RE.test(v)) continue
      // href/xlink:href 需额外校验 data: 仅允许 image/svg+xml 与 image/png/jpeg/webp
      if((k==='href' || k==='xlink:href') && /^data:/i.test(v.trim())){
        if(!/^data:image\/(svg\+xml|png|jpeg|gif|webp);base64,/i.test(v.trim())) continue
      }
      kept.push(`${am[1]}="${v.replace(/"/g,'&quot;')}"`)
    }
    return `<${tag}${kept.length? ' '+kept.join(' ') : ''}${isSelfClose?'/>':'>'}`
  })
  // 5. 最终兜底：残留的危险协议在文本节点中再次清除
  out = out.replace(/javascript\s*:/gi, '').replace(/vbscript\s*:/gi, '').replace(/data\s*:\s*text\/html/gi, '')
  return out.trim()
}
