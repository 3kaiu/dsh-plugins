'use strict'
// adapter-vue — neutral-tree → Vue SFC（技术无关树的中立性验证，doc15 §6）
//
// 生成代码注入防护：neutral 树来自不可信的参考稿解析/外部 JSON——
// 文本一律经 HTML 转义进入模板；style 属性值先剥离 CSS 结构字符
// （;{}\<>）再做属性转义，杜绝属性逃逸与声明注入；几何值经 Number
// 钳制为有限数，非数值丢弃；原始 SVG 不内联（与 React 适配器同策略）。

// 共享件(doc19 批2d): num 钳制/tag 映射/HTML 转义与 React 侧同源;
// 本文件的注入防护策略(文本 HTML 转义 + cssValue 结构字符剥离)保持独立。
import { num, neutralTag as vueTag, escText, escAttr, cssValue } from './neutral-common.ts'

export function neutralToVue(neutral) {
  const root = neutral.root || neutral
  const children = (root.children || []).map(n => vueNode(n)).join('\n')
  const canvas = neutral.meta?.canvas || root
  const bg = typeof canvas.background === 'string' && canvas.background ? canvas.background : '#fff'
  return [
    `<template>`,
    `  <div class="page" style="width:${num(canvas.width)}px;height:${num(canvas.height)}px;background:${cssValue(bg)}">`,
    children.split('\n').map(l => '    ' + l).join('\n'),
    `  </div>`,
    `</template>`,
    ``,
    `<script setup>`,
    `// auto-generated from neutral-tree ${escAttr(neutral.format || 'v1')}`,
    `</script>`,
  ].join('\n')
}

function vueNode(n) {
  const style = vueStyle(n)
  const tag = vueTag(n)
  const children = (n.children || []).map(vueNode).join('')
  const content = n.text ? escText(n.text) : children
  const extra = n.svg ? `<!-- svg -->` : ''
  return `<${tag} style="${style}">${content}${extra}</${tag}>`
}

function vueStyle(n) {
  const parts = []
  const px = (prop: any, v: any) => {
    const k = num(v)
    if (k != null) parts.push(`${prop}:${k}px`)
  }
  px('left', n.x)
  px('top', n.y)
  px('width', n.width)
  px('height', n.height)
  if (typeof n.bg === 'string' && n.bg) parts.push(`background:${cssValue(n.bg)}`)
  if (typeof n.color === 'string' && n.color) parts.push(`color:${cssValue(n.color)}`)
  if (n.font?.size != null && num(n.font.size) != null) parts.push(`font-size:${num(n.font.size)}px`)
  if (typeof n.font?.family === 'string' && n.font.family) parts.push(`font-family:${cssValue(n.font.family)}`)
  if (n.opacity != null && num(n.opacity) != null) parts.push(`opacity:${num(n.opacity)}`)
  return parts.join(';')
}
