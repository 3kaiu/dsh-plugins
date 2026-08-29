'use strict'
// Agent System Prompt — 单一来源为 preset/ui-reverse/prompt.md（随 tarball 一同发布）。
// 此前 persona 在本文件与 prompt.md 双份维护且已漂移；现改为运行时读取，
// 从结构上消除双份漂移。占位符（{{PROJECT_PATH}} 等）由宿主/渲染方注入。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 注意：本文件会被 bundle 进 dist/index.js，import.meta.url 指向 dist/，
// 故 persona 相对 dist 上一级（包根）的 preset/ 目录。
const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'preset', 'ui-reverse', 'prompt.md')

export let PROMPT_TEMPLATE
try {
  PROMPT_TEMPLATE = readFileSync(PROMPT_FILE, 'utf8')
} catch (error) {
  throw new Error(
    `ui-reverse-agent: persona 模板缺失（${PROMPT_FILE}）— preset/ui-reverse/prompt.md 必须与 dist 一同发布`,
    { cause: error },
  )
}

export function renderPrompt(vars: Record<string, any> = {}) {
  let out = PROMPT_TEMPLATE
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ''))
  }
  return out
}
