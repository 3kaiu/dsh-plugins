'use strict'
// docs — 34 工具与 helpers 的自动文档生成（供 marketplace/README 消费）

export function generateToolDocs(tools: any) {
  const lines = ['# UI Reverse Agent — Tools', '']
  for (const t of tools as any[]) {
    lines.push(`## ${t.name}`)
    lines.push(t.description || '')
    lines.push('')
    if (t.parameters) {
      lines.push(`**Parameters:**`)
      for (const [k, v] of Object.entries(t.parameters) as [string, any][]) {
        lines.push(`- \`${k}\`: ${v.description || v.type} ${v.required ? '(required)' : ''}`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

export function generateHelperDocs(helpers: any) {
  const lines = ['# Helpers', '']
  for (const h of helpers) {
    lines.push(`- \`${h.name}\`: ${h.description}`)
  }
  return lines.join('\n')
}
