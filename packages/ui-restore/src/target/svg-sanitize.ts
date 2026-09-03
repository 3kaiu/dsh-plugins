// target/svg-sanitize.ts — SVG 白名单消毒（P1 安全深化，第3轮加固）
// 仅允许 svg/g/path/circle/rect/line/polyline/polygon/ellipse/use/defs/clipPath/mask
// 禁止 script、事件属性(on*), javascript:/data:text/html/vbscript: 外链、style 表达式、实体编码绕过
//
// 关键修复（第3轮）: 旧版只在「属性值」上解码实体，导致 &#60;script&#62; / &lt;svg onload&gt;
// / javascript&colon; 等可在文档体/标签名/URL 中绕过白名单。现改为：先对【整段】输入做实体解码，
// 并迭代到稳定，再执行标签/属性白名单过滤，彻底消除实体编码绕过。

const ALLOWED_TAGS = new Set(['svg','g','path','circle','rect','line','polyline','polygon','ellipse','use','defs','clipPath','mask','linearGradient','radialGradient','stop','filter','feGaussianBlur','feOffset','feComposite','feBlend','feColorMatrix','femerge','femergenode','feFuncR','feFuncG','feFuncB','feFuncA'])
const ALLOWED_ATTRS = new Set(['d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','opacity','transform','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','points','href','xlink:href','gradientUnits','gradientTransform','offset','stop-color','stop-opacity','flood-color','flood-opacity','stdDeviation','dx','dy','in','in2','result','operator','type','values','color','fill-opacity','stroke-opacity','xmlns','xmlns:xlink','id','clip-path','mask','preserveAspectRatio','fill-rule','stroke-dasharray','stroke-dashoffset','text-anchor','font-size','font-family','letter-spacing'])

// 仅解码「能被用于绕过的危险命名实体」，其余命名实体保持原样（避免误伤合法文本）。
// 数值实体(&#NN; / &#xHH;) 可编码任意字符，是主要绕过手段，必须全量解码。
const NAMED_BYPASS = {
  colon: ':', sol: '/', tab: '\t', newline: '\n', lpar: '(', rpar: ')',
  lsqb: '[', rsqb: ']', quot: '"', amp: '&', lt: '<', gt: '>', apos: "'",
  num: '#', semi: ';', period: '.', comma: ',', equals: '=', slashes: '//',
  nbsp: ' ', amp2: '&',
}

/** 解码整段字符串中的实体: 数值实体全量 + 危险命名实体 */
function decodeAll(s: string): string {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => (name.toLowerCase() in NAMED_BYPASS ? (NAMED_BYPASS as any)[name.toLowerCase()] : m))
}

// 仅映射合法码点，避免产生代理对半截或控制字符注入
function safeFromCode(cp: number): string {
  if (!isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
  // 丢弃 ASCII 控制字符（除常见的空白 \t \n \r）以阻止不可见绕过
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return ''
  try { return String.fromCodePoint(cp) } catch { return '' }
}

/** 迭代解码直到稳定（防双重/多重编码绕过） */
function decodeStable(s: string): string {
  let prev = s
  for (let i = 0; i < 6; i++) {
    const next = decodeAll(prev)
    if (next === prev) break
    prev = next
  }
  return prev
}

const DANGEROUS_URL_RE = /(?:javascript\s*:|data\s*:\s*text\/html|vbscript\s*:)/i
const STYLE_URL_RE = /expression\s*\(|url\s*\(\s*['"]?\s*javascript/i

/** 整段预解码后再执行属性值检查（保持旧逻辑兼容） */
function decodeAttrValue(v: string): string {
  return decodeStable(v)
}

/**
 * 白名单消毒：先对整段做实体解码（迭代至稳定），再做标签/属性白名单过滤。
 * 字符串级过滤，无需 DOMParser（Node 环境零依赖）。
 */
export function sanitizeSvg(svg: string): string {
  if (!svg || typeof svg !== 'string') return ''
  // 0. 整段实体解码（核心修复: 旧版只在属性值上解码，文档体/标签名可绕过）
  let out = decodeStable(svg)
  // 1. 移除 script 块（含大小写与属性）
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '')
  // 1b. 移除 foreignObject / iframe / object / embed / use 外链脚本容器（标签整体剥离，保留内部已无意义故一并去标签）
  out = out.replace(/<\/?(?:foreignObject|iframe|object|embed|link|meta)[\s\S]*?>/gi, '')
  // 2. 移除事件属性：覆盖 <svg/onload=...> 斜杠后无空格写法
  out = out.replace(/[\s\/]+on\w+\s*=\s*(['"]).*?\1/gi, '')
  out = out.replace(/[\s\/]+on\w+\s*=\s*[^\s"'`>]+/gi, '')
  // 3. 逐标签白名单
  out = out.replace(/<\/?([a-zA-Z0-9:]+)(\s[^>]*?)?\s*\/?>/g, (m, tag, attrs) => {
    const t = String(tag).toLowerCase().split(':').pop() || ''
    const isClose = m.startsWith('</')
    const isSelfClose = /\/\s*>$/.test(m)
    if (!ALLOWED_TAGS.has(t)) {
      if (t === 'svg') return m
      return ''
    }
    if (isClose) return `</${tag}>`
    if (!attrs) return isSelfClose ? `<${tag}/>` : `<${tag}>`
    const kept: string[] = []
    const attrRe = /([a-zA-Z0-9:_\-]+)\s*=\s*(['"])(.*?)\2/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(attrs))) {
      let k = am[1].toLowerCase()
      let v = am[3]
      if (!ALLOWED_ATTRS.has(k) && !k.startsWith('data-')) continue
      if (k === 'style') continue
      // 属性值二次解码后校验（防值内残留编码绕过）
      const dv = decodeAttrValue(v)
      if (DANGEROUS_URL_RE.test(dv) || STYLE_URL_RE.test(dv)) continue
      if (DANGEROUS_URL_RE.test(v) || STYLE_URL_RE.test(v)) continue
      // href/xlink:href 仅允许 raster data:（svg+xml data URI 可被独立文档加载执行脚本，禁止）
      if ((k === 'href' || k === 'xlink:href') && /^data:/i.test(v.trim())) {
        if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(v.trim())) continue
      }
      // 拦截 javascript:/vbscript: 通过非 data: 的 href
      if ((k === 'href' || k === 'xlink:href') && /^(?:javascript|vbscript)\s*:/i.test(v.trim())) continue
      kept.push(`${am[1]}="${v.replace(/"/g, '&quot;')}"`)
    }
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}${isSelfClose ? '/>' : '>'}>`
  })
  // 4. 最终兜底：文本节点中残留的危险协议再次清除
  out = out.replace(/javascript\s*:/gi, '').replace(/vbscript\s*:/gi, '').replace(/data\s*:\s*text\/html/gi, '')
  return out.trim()
}
