'use strict'
// adapter-react — neutral-tree → React JSX（与 Vue 适配器同源，验证中立性）

export function neutralToReact(neutral) {
  const root = neutral.root || neutral
  const children = (root.children || []).map(n => reactNode(n)).join('\n')
  const canvas = neutral.meta?.canvas || root
  return [
    `export default function Page() {`,
    `  return (`,
    `    <div style={{width:${canvas.width},height:${canvas.height},background:'${canvas.background || '#fff'}'}}>`,
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
  const content = n.text ? n.text : children
  const extra = n.svg ? `{/* svg */}` : ''
  return `<${tag} style={${style}}>${content}${extra}</${tag}>`
}

function reactTag(n) {
  if (n.kind === 'text') return 'span'
  if (n.kind === 'icon') return 'i'
  if (n.kind === 'image') return 'img'
  return 'div'
}

function reactStyle(n) {
  const parts = []
  if (n.x != null) parts.push(`left:${n.x}`)
  if (n.y != null) parts.push(`top:${n.y}`)
  if (n.width != null) parts.push(`width:${n.width}`)
  if (n.height != null) parts.push(`height:${n.height}`)
  if (n.bg) parts.push(`background:'${typeof n.bg === 'string' ? n.bg : '#fff'}'`)
  if (n.color) parts.push(`color:'${n.color}'`)
  return `{${parts.join(',')}}`
}
