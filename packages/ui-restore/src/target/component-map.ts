// target/component-map.ts — ⑱ Component Library Mapping
// 将 Blueprint 节点映射到目标组件库(antd 等)的语义组件，绝不强行映射
// 保守策略：仅当几何/样式/内容强信号同时满足时才映射，否则 native

import type { TargetProfile } from './types.ts'

export interface LibraryComponent {
  library: string
  component: string
  importFrom: string
  props: Record<string, any>
  confidence: number
  reason: string
}

// 启发式阈值
const BTN_HEIGHT = [28, 44]
const BTN_RADIUS = [4, 12]
const CARD_MIN = 80

function isButtonLike(n:any): {score:number, reason:string} | null {
  const b = n.bounds || {}
  const h = b.height ?? 0, w = b.width ?? 0
  const ly = n.layout || {}
  const hasText = typeof n.text === 'string' && n.text.trim().length>0 && n.text.trim().length<=12
  const singleTextChild = Array.isArray(n.children) && n.children.length===1 && typeof n.children[0].text==='string'
  const textOk = hasText || singleTextChild
  if(!textOk) return null
  if(h < BTN_HEIGHT[0] || h > BTN_HEIGHT[1]) return null
  if(w < 48 || w > 200) return null
  // 圆角
  const r = ly.borderRadius ?? n.borderRadius
  const rad = Array.isArray(r) ? r[0] : (typeof r==='number'?r:null)
  if(rad!=null && (rad < BTN_RADIUS[0] || rad > BTN_RADIUS[1])) return null
  // 有填充或描边（按钮通常有背景或边框）
  const hasFill = !!n.color || !!n.fill || !!n.stroke
  if(!hasFill) return null
  return { score: 0.82, reason: `按钮启发式: ${w}x${h} 文本"${String(n.text||n.children?.[0]?.text||'').slice(0,8)}" 圆角${rad??'缺省'}` }
}

function isTagLike(n:any): {score:number, reason:string} | null {
  const b=n.bounds||{}
  const h=b.height??0,w=b.width??0
  if(h<16 || h>28) return null
  if(w<24 || w>120) return null
  const r = n.layout?.borderRadius ?? n.borderRadius
  const rad = Array.isArray(r) ? Math.max(...r) : (typeof r==='number'?r:0)
  if(rad < 8) return null
  if(typeof n.text!=='string' || !n.text.trim()) return null
  return { score:0.78, reason:`Tag 启发式: ${w}x${h} 胶囊文本` }
}

function isCardLike(n:any): {score:number, reason:string} | null {
  const b=n.bounds||{}
  if(b.width < CARD_MIN || b.height < CARD_MIN) return null
  const hasImage = !!(n.fill?.type==='image' || (n.children||[]).some((c:any)=> c.fill?.type==='image'))
  const hasText = !!(typeof n.text==='string' && n.text) || (n.children||[]).some((c:any)=> typeof c.text==='string' && c.text)
  if(!hasImage || !hasText) return null
  return { score:0.75, reason:`Card 启发式: ${b.width}x${b.height} 图文容器` }
}

/**
 * 单节点 → 库组件映射（保守，仅高置信）
 * @param n Blueprint 节点
 * @param profile TargetProfile（含 componentLibraries）
 */
export function mapToLibrary(n:any, profile: TargetProfile): LibraryComponent | null {
  const libs = profile.componentLibraries || []
  if(!libs.length) return null
  // 优先级：antd / @arco / antd-mobile 等
  const hasAntd = libs.some(l=> /antd/.test(l))
  const hasArco = libs.some(l=> /arco/.test(l))
  const lib = hasAntd ? 'antd' : hasArco ? '@arco-design/web-react' : null
  if(!lib) return null

  // 仅对叶子或单层容器做映射，避免把复杂布局容器误判为按钮
  const btn = isButtonLike(n)
  if(btn) return { library: lib, component: 'Button', importFrom: lib, props: { type: n.color && /1677ff|1890ff/i.test(String(n.color)) ? 'primary' : 'default' }, confidence: btn.score, reason: btn.reason }

  const tag = isTagLike(n)
  if(tag) return { library: lib, component: 'Tag', importFrom: lib, props: {}, confidence: tag.score, reason: tag.reason }

  const card = isCardLike(n)
  if(card) return { library: lib, component: 'Card', importFrom: lib, props: {}, confidence: card.score, reason: card.reason }

  return null
}

/** 批量：遍历 Blueprint 树，返回 nodeId → LibraryComponent */
export function mapBlueprintToLibrary(bp:any, profile: TargetProfile): Map<string, LibraryComponent> {
  const out = new Map<string, LibraryComponent>()
  const walk = (n:any)=>{
    if(!n || typeof n!=='object') return
    const m = mapToLibrary(n, profile)
    if(m) out.set(n.id, m)
    for(const c of n.children||[]) walk(c)
  }
  for(const r of [...(bp?.tree||[]), ...(bp?.floatings||[])]) walk(r)
  return out
}
