'use strict'
// typedoc — API 文档的自动生成（基于 JSDoc 与工具元数据）

export function generateApiDocs(tools) {
  return tools.map(t => `### ${t.name}\n${t.description}\n`).join('\n')
}

export function exampleSnippet(toolName) {
  const examples = {
    reference_ingest: `await referenceIngest({ dsl, viewport: {width:1440,height:900} })`,
    compare_geometry: `compareGeometry({ referenceTree, implementedTree, tolerance:2 })`,
    fanout_evaluate: `fanoutEvaluate({ mismatch, candidates:[24,16], referenceTree, implementedTree })`,
  }
  return examples[toolName] || `// example for ${toolName}`
}
