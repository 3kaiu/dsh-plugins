'use strict'
// adapter-react — neutral-tree → React JSX（与 Vue 适配器同源，验证中立性）
//
// 生成代码注入防护：neutral 树来自不可信的参考稿解析/外部 JSON，其中任何
// 文本与样式值都不得裸插值进 JSX——字符串一律以 JSON.stringify 产出 JS
// 字符串字面量，几何值一律经 Number 钳制为有限数（非数值直接丢弃），
// 原始 SVG 不内联（与 Vue 适配器同策略，仅留注释占位）。

// 共享件(doc19 批2d): num 钳制与 tag 映射与 Vue 侧同源; 本文件的注入防护策略
// (字符串一律 JSON.stringify 字面量, 几何值 num 钳制, SVG 仅注释占位)保持独立。
import { num, neutralTag as reactTag } from './neutral-common.ts'

const str = (v: any, fallback: any) => JSON.stringify(typeof v === 'string' && v ? v : (fallback ?? ''))

export function neutralToReact(neutral) {
  const root = neutral.root || neutral
  const children = (root.children || []).map(n => reactNode(n)).join('\n')
  const canvas = neutral.meta?.canvas || root
  return [
    `export default function Page() {`,
    `  return (`,
    `    <div style={{width:${JSON.stringify(num(canvas.width))},height:${JSON.stringify(num(canvas.height))},background:${str(canvas.background, '#fff')}}}>`,
    children.split('\n').map(l => '      ' + l).join('\n'),
    `    </div>`,
    `  )`,
    `}`,
  ].join('\n')
}

function reactNode(n) {
  const style = reactStyle(n)
  const tag = reactTag(n)
  const children = (n.children || []).map(reactNode).join('')
  const content = n.text ? `{${JSON.stringify(String(n.text))}}` : children
  const extra = n.svg ? `{/* svg */}` : ''
  return `<${tag} style={${style}}>${content}${extra}</${tag}>`
}

function reactStyle(n) {
  const parts = []
  const px = (prop: any, v: any) => {
    const k = num(v)
    if (k != null) parts.push(`${prop}:${k}`)
  }
  px('left', n.x)
  px('top', n.y)
  px('width', n.width)
  px('height', n.height)
  if (typeof n.bg === 'string' && n.bg) parts.push(`background:${JSON.stringify(n.bg)}`)
  if (typeof n.color === 'string' && n.color) parts.push(`color:${JSON.stringify(n.color)}`)
  return `{${parts.join(',')}}`
}
