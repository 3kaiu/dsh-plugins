'use strict'
// compare_palette：主色提取 + CIEDE2000 ΔE 对比
// 输入：referencePalette / implementedPalette（hex 数组）或两棵树（自动提取）
// 输出：{ colors: [{reference, nearest, deltaE, pass}], stats: {meanDeltaE, maxDeltaE, fails} }

// --- 颜色解析 ---

function parseColor(str) {
  if (!str || typeof str !== 'string') return null
  const s = str.trim().toLowerCase()
  // hex #rgb #rrggbb #rrggbbaa
  let m = s.match(/^#([0-9a-f]{3,8})$/)
  if (m) {
    let hex = m[1]
    if (hex.length === 3) hex = hex.split('').map(c => c+c).join('')
    if (hex.length === 4) hex = hex.slice(0,3).split('').map(c=>c+c).join('') // ignore alpha
    if (hex.length === 8) hex = hex.slice(0,6)
    if (hex.length === 6) return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) }
  }
  // rgb / rgba
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) return { r: parseInt(m[1],10), g: parseInt(m[2],10), b: parseInt(m[3],10) }
  // 忽略 transparent / gradient 等
  if (s === 'transparent' || s.startsWith('linear-') || s.startsWith('url(')) return null
  return null
}

function toHex({ r, g, b }) {
  return '#' + [r,g,b].map(v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('')
}

// --- RGB -> XYZ -> Lab ---

function srgbToLinear(c) {
  const cs = c / 255
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
}
function rgbToXyz({ r, g, b }) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b)
  // sRGB D65
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750
  const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041
  return { X: X*100, Y: Y*100, Z: Z*100 }
}
function xyzToLab({ X, Y, Z }) {
  const Xn=95.047, Yn=100, Zn=108.883
  const xr=X/Xn, yr=Y/Yn, zr=Z/Zn
  const f = t => t > 0.008856 ? Math.pow(t, 1/3) : (7.787*t + 16/116)
  const fx=f(xr), fy=f(yr), fz=f(zr)
  const L = 116*fy - 16
  const a = 500*(fx - fy)
  const b = 200*(fy - fz)
  return { L, a, b }
}
function rgbToLab(rgb) { return xyzToLab(rgbToXyz(rgb)) }

// --- CIEDE2000 (简化实现，参考 Sharma et al. 2005) ---
function ciede2000(lab1, lab2) {
  const L1=lab1.L, a1=lab1.a, b1=lab1.b
  const L2=lab2.L, a2=lab2.a, b2=lab2.b
  const kL=1, kC=1, kH=1
  const C1=Math.sqrt(a1*a1 + b1*b1), C2=Math.sqrt(a2*a2 + b2*b2)
  const Cbar=(C1+C2)/2
  const Cbar7=Math.pow(Cbar,7)
  const G=0.5*(1 - Math.sqrt(Cbar7/(Cbar7 + Math.pow(25,7))))
  const ap1=(1+G)*a1, ap2=(1+G)*a2
  const Cp1=Math.sqrt(ap1*ap1 + b1*b1), Cp2=Math.sqrt(ap2*ap2 + b2*b2)
  const CpBar=(Cp1+Cp2)/2
  const hp1 = Math.atan2(b1, ap1) *180/Math.PI, h1 = hp1 <0 ? hp1+360 : hp1
  const hp2 = Math.atan2(b2, ap2)*180/Math.PI, h2 = hp2 <0 ? hp2+360 : hp2
  const dLp = L2 - L1
  const dCp = Cp2 - Cp1
  let dhp = 0
  if (Cp1*Cp2 < 1e-9) dhp=0
  else {
    let d = h2 - h1
    if (Math.abs(d) <= 180) dhp=d
    else if (d > 180) dhp=d-360
    else dhp=d+360
  }
  const dHp = 2*Math.sqrt(Cp1*Cp2)*Math.sin(dhp*Math.PI/360)
  const LpBar=(L1+L2)/2
  const hpBar = Cp1*Cp2 <1e-9 ? h1+h2 : Math.abs(h1-h2)>180 ? (h1+h2+360)/2 : (h1+h2)/2

  const T = 1 -0.17*Math.cos((hpBar-30)*Math.PI/180)+0.24*Math.cos(2*hpBar*Math.PI/180)+0.32*Math.cos((3*hpBar+6)*Math.PI/180)-0.20*Math.cos((4*hpBar-63)*Math.PI/180)
  const dTheta = 30*Math.exp(-Math.pow((hpBar-275)/25,2))
  const CpBar7=Math.pow(CpBar,7)
  const Rc = 2*Math.sqrt(CpBar7/(CpBar7+Math.pow(25,7)))
  const LpBar50Sq = Math.pow(LpBar-50,2)
  const Sl = 1 + 0.015*LpBar50Sq/Math.sqrt(20+LpBar50Sq)
  const Sc = 1 +0.045*CpBar
  const Sh = 1 +0.015*CpBar*T
  const Rt = -Math.sin(2*dTheta*Math.PI/180)*Rc

  const termL = dLp/(kL*Sl)
  const termC = dCp/(kC*Sc)
  const termH = dHp/(kH*Sh)
  return Math.sqrt(termL*termL + termC*termC + termH*termH + Rt*termC*termH)
}

function deltaE(rgb1, rgb2) {
  const lab1=rgbToLab(rgb1), lab2=rgbToLab(rgb2)
  return ciede2000(lab1, lab2)
}

// --- 提取调色板 ---

function collectColorsFromNode(n, out) {
  const candidates = []
  if (n._color) candidates.push(n._color)
  if (n.fill) candidates.push(n.fill)
  if (n.textColor) candidates.push(n.textColor)
  if (n.effect && typeof n.effect === 'string') {
    // shadow 可能含色值，忽略
  }
  if (n.computed) {
    const c = n.computed
    if (c.color) candidates.push(c.color)
    if (c.backgroundColor) candidates.push(c.backgroundColor)
    if (c.borderColor) candidates.push(c.borderColor)
    if (c.fill) candidates.push(c.fill)
  }
  if (n.styles) {
    for (const v of Object.values(n.styles) as any[]) {
      if (v && typeof v.value === 'string' && v.value.startsWith('#')) candidates.push(v.value)
      if (Array.isArray(v?.value) && typeof v.value[0] === 'string' && v.value[0].startsWith('#')) candidates.push(v.value[0])
    }
  }
  for (const s of candidates) {
    const rgb = parseColor(s)
    if (rgb) out.push(rgb)
  }
}

function extractPaletteFromTree(tree) {
  const colors = []
  const walk = (nodes) => {
    for (const n of nodes) {
      collectColorsFromNode(n, colors)
      if (n.children) walk(n.children)
    }
  }
  walk(Array.isArray(tree) ? tree : [tree])
  // 去重 + 量化（简单：按 hex 去重，取前 12 主色按出现频次）
  const freq = new Map()
  for (const c of colors) {
    const hex = toHex(c)
    freq.set(hex, (freq.get(hex)||0)+1)
  }
  // 忽略近白/近透明？保留
  const sorted = [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 12).map(([hex])=>hex)
  return sorted
}

function expandPalette(palette) {
  // palette 可能是 hex 字符串数组 或 {color,count} 或 styles 映射
  if (!palette) return []
  if (Array.isArray(palette)) {
    const out=[]
    for (const c of palette) {
      if (typeof c === 'string') { const rgb=parseColor(c); if(rgb) out.push({hex:toHex(rgb), rgb}) }
      else if (c && typeof c.color === 'string') { const rgb=parseColor(c.color); if(rgb) out.push({hex:toHex(rgb), rgb}) }
      else if (c && c.hex) { const rgb=parseColor(c.hex); if(rgb) out.push({hex:toHex(rgb), rgb}) }
    }
    return out
  }
  if (typeof palette === 'object') {
    return expandPalette(Object.values(palette))
  }
  return []
}

export function comparePalette({ referenceTree, implementedTree, referencePalette, implementedPalette, deltaEThreshold = 3 }) {
  let refPal = referencePalette ? expandPalette(referencePalette) : (referenceTree ? expandPalette(extractPaletteFromTree(referenceTree)) : [])
  let implPal = implementedPalette ? expandPalette(implementedPalette) : (implementedTree ? expandPalette(extractPaletteFromTree(implementedTree)) : [])

  if (refPal.length === 0 && implPal.length === 0) return { colors: [], stats: { meanDeltaE: 0, maxDeltaE: 0, fails: 0, total:0 } }
  // 若实现侧为空但有参考色，报 missing
  const colors=[]
  let sum=0, max=0, fails=0
  for (const ref of refPal) {
    let best=null, bestDelta=Infinity
    for (const impl of implPal) {
      const d = deltaE(ref.rgb, impl.rgb)
      if (d < bestDelta) { bestDelta=d; best=impl }
    }
    if (!Number.isFinite(bestDelta)) bestDelta=100 // 无近似色
    const pass = bestDelta <= deltaEThreshold
    if (!pass) fails++
    sum+=bestDelta
    if (bestDelta>max) max=bestDelta
    colors.push({ reference: ref.hex, nearest: best ? best.hex : null, deltaE: Math.round(bestDelta*10)/10, pass, threshold: deltaEThreshold })
  }
  // 实现侧多余色（extra）不惩罚，仅列出？
  const implExtra = implPal.filter(ip => !colors.some(c=>c.nearest===ip.hex)).map(c=>c.hex)

  const mean = refPal.length ? Math.round((sum/refPal.length)*10)/10 : 0
  return { colors: colors.sort((a,b)=>b.deltaE-a.deltaE), extra: implExtra, stats: { meanDeltaE: mean, maxDeltaE: Math.round(max*10)/10, fails, total: refPal.length } }
}

export { parseColor, rgbToLab, ciede2000, deltaE, extractPaletteFromTree, toHex }
