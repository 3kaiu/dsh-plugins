'use strict'
// adapter-vue — neutral-tree → Vue SFC（技术无关树的中立性验证，doc15 §6）

export function neutralToVue(neutral) {
  const root = neutral.root || neutral
  const children = (root.children || []).map(n => vueNode(n)).join('\n')
  const canvas = neutral.meta?.canvas || root
  return [
    `<template>`,
    `  <div class="page" style="width:${canvas.width}px;height:${canvas.height}px;background:${canvas.background || '#fff'}">`,
    children.split('\n').map(l => '    ' + l).join('\n'),
    `  </div>`,
    `</template>`,
    ``,
    `<script setup>`,
    `// auto-generated from neutral-tree ${neutral.format || 'v1'}`,
    `</script>`,
  ].join('\n')
}

function vueNode(n) {
  const style = vueStyle(n)
  const tag = vueTag(n)
  const children = (n.children || []).map(vueNode).join('')
  const content = n.text ? escapeHtml(n.text) : children
  const extra = n.svg ? n.svg : ''
  return `<${tag} style="${style}">${content}${extra}</${tag}>`
}

function vueTag(n) {
  if (n.kind === 'text') return 'span'
  if (n.kind === 'icon') return 'i'
  if (n.kind === 'image') return 'img'
  return 'div'
}

function vueStyle(n) {
  const parts = []
  if (n.x != null) parts.push(`left:${n.x}px`)
  if (n.y != null) parts.push(`top:${n.y}px`)
  if (n.width != null) parts.push(`width:${n.width}px`)
  if (n.height != null) parts.push(`height:${n.height}px`)
  if (n.bg) parts.push(`background:${typeof n.bg === 'string' ? n.bg : '#fff'}`)
  if (n.color) parts.push(`color:${n.color}`)
  if (n.font?.size) parts.push(`font-size:${n.font.size}px`)
  if (n.font?.family) parts.push(`font-family:${n.font.family}`)
  if (n.opacity != null) parts.push(`opacity:${n.opacity}`)
  return parts.join(';')
}

function escapeHtml(s) { return s.replace(/</g,'&lt;').replace(/>/g,'&gt;') }
