'use strict'
// marketplace — Preset 的发布/发现/组合元数据（供 DSH marketplace / dsh plugin search 消费）

export const MARKETPLACE_META = {
  id: 'ui-reverse',
  name: 'UI Reverse Engineering Agent',
  version: '0.1.0',
  description: '1:1 视觉还原 Agent — 参考 UI（截图/DSL/中立树）→ 浏览器闭环对比（五层评分/扇出择优/约束/a11y）→ 迭代至 0.96',
  keywords: ['ui', 'visual', 'reverse', 'pixel-perfect', 'playwright', 'mastergo'],
  author: '3kaiu',
  license: 'MIT',
  dsh: {
    preset: 'preset/ui-reverse',
    bundle: '@3kaiu/dsh-ui-reverse-agent',
    engines: { dsh: '>=0.1.0-rc.6', node: '>=20' },
    requires: ['@3kaiu/dsh-layout-infer', '@3kaiu/dsh-plugin-kit'],
    optional: ['dsh-lsp', 'dsh-jobs', 'dsh-storage', 'dsh-workflow-engine'],
    tools: 34,
    viewports: ['desktop', 'tablet', 'mobile'],
    states: ['default', 'hover', 'active', 'disabled'],
  },
  composition: {
    // 与 standard preset 的组合示例：ui-reverse 继承 standard 的 fs/skill，再叠加视觉能力
    extends: 'standard',
    overrides: ['persona', 'tools:ui-reverse'],
  },
}

export function describeComposition() {
  return {
    standalone: 'preset ui-reverse — 独立视觉还原',
    withStandard: 'preset ui-reverse extends standard — 兼具文件/技能与视觉能力',
    ci: 'workflow preset/ui-reverse/workflow.yml — CI 门禁 S≥0.96',
  }
}

export function marketplaceReadme() {
  return [
    `# ${MARKETPLACE_META.name} (${MARKETPLACE_META.id})`,
    ``,
    MARKETPLACE_META.description,
    ``,
    `Tools: ${MARKETPLACE_META.dsh.tools} | Viewports: ${MARKETPLACE_META.dsh.viewports.join(',')} | States: ${MARKETPLACE_META.dsh.states.join(',')}`,
    ``,
    `Install: \`dsh plugin add @3kaiu/dsh-ui-reverse-agent && dsh preset add ui-reverse\``,
  ].join('\n')
}
