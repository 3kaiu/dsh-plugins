'use strict'
// neutral-common — React/Vue 中立适配器共享件(doc19 §2.2 批2d 收敛)
//
// 两侧曾各持一份 num 钳制/tag 映射/HTML 转义, 已漂移风险与双份维护成本收敛于此。
// 注入防护策略差异刻意保留在各自文件: React 侧文本走 JSON 字符串字面量(JSON.stringify),
// Vue 侧走 HTML 转义 + cssValue 结构字符剥离 —— 语义不同, 不强行合一。

/** 几何值钳制: 非有限数一律 null(调用方丢弃), 防注入与 NaN 传播 */
export const num = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 中立树节点 → HTML 标签(React JSX 与 Vue template 同构映射) */
export function neutralTag(n: any) {
  if (n.kind === 'text') return 'span'
  if (n.kind === 'icon') return 'i'
  if (n.kind === 'image') return 'img'
  return 'div'
}

export const escText = (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const escAttr = (s: any) => escText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** style 属性值: 先剥离 CSS 结构字符(;{}\<> 防声明注入/属性逃逸)再做属性转义 */
export const cssValue = (v: any) => escAttr(String(v).replace(/[;{}\\<>]/g, ' ').replace(/\s+/g, ' ').trim())
