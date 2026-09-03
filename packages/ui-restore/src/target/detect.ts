// target/detect.ts — Project Analyzer(观察事实, 带置信度, 不做决策)
//
// 输入: 项目根目录。扫描 package.json / pubspec.yaml / app.json+.wxml / *.swift /
//       tsconfig / vite|webpack 配置 / 样式文件形态。
// 输出: ProjectFacts —— 每个维度是置信度降序的候选列表。
// 铁律: 本模块只观察, 不选择; 缺证据的维度输出空数组(由 Resolver 判 unknown)。
import fs from 'node:fs'
import path from 'node:path'
import type { ProjectFacts, Candidate } from './types.ts'
import { readJsonTolerant as readJson, readTextTolerant as readText } from '../fs-util.ts'

const exists = (p: any) => { try { return fs.statSync(p).isFile() } catch { return false } }

function walk(dir: any, depth: any, out: any, maxDepth = 4) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (depth < maxDepth) walk(p, depth + 1, out, maxDepth) }
    else out.push(p)
  }
}

/** 收集文件(限深, 跳过 node_modules/dist), 返回相对项目根路径 */
export function listFiles(projectDir: any, maxDepth = 4) {
  const out: any[] = []
  walk(projectDir, 0, out, maxDepth)
  return out.map((p: any) => path.relative(projectDir, p).split(path.sep).join('/'))
}

function push(list: any, name: any, confidence: any, evidence: any) {
  if (confidence <= 0) return
  const cur = list.find((c: any) => c.name === name)
  if (!cur || cur.confidence < confidence) {
    const i = list.findIndex((c: any) => c.name === name)
    const item = { name, confidence: Math.min(1, confidence), evidence }
    if (i >= 0) list[i] = item
    else list.push(item)
  }
  list.sort((a: any, b: any) => b.confidence - a.confidence)
}

/**
 * 扫描项目目录 → 置信度排序的观察事实。
 * @param {string} projectDir 项目根
 * @returns {ProjectFacts}
 */
export function detectProjectFacts(projectDir: any) {
  const facts = {
    framework: [], language: [], styling: [], build: [], componentLibraries: [],
    entry: {} as Record<string, any>, notes: [],
  }
  const pkg = readJson(path.join(projectDir, 'package.json'))
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) }
  const files = listFiles(projectDir)
  const has = (re: any) => files.some((f: any) => re.test(f))

  // ---- Web 栈(package.json 证据, 优先级高于文件形态) ----
  if (pkg) {
    const dep = (n: any, c: any) => deps[n] != null && push(facts.framework, n === 'react-dom' ? 'react' : n, c, `package.json:${n}`)
    dep('react', 0.99); dep('vue', 0.95); dep('svelte', 0.9); dep('solid-js', 0.85)
    if (deps.next) { push(facts.framework, 'next', 0.97, 'package.json:next'); push(facts.framework, 'react', 0.9, 'next 隐含 react') }
    if (deps.react || deps['react-dom'] || deps.next) push(facts.language, 'typescript', has(/^tsconfig\.(json|mjs|cjs)$/) ? 1 : 0.7, has(/^tsconfig/) ? 'tsconfig.json' : 'react 生态默认')
    if (deps.typescript) push(facts.language, 'typescript', Math.max(0.9, deps.typescript ? 0.9 : 0), 'package.json:typescript')
    if (!deps.typescript && !has(/^tsconfig/)) push(facts.language, 'javascript', 0.8, '无 tsconfig/typescript 依赖')

    // styling: 逐证据累加, 互不排斥(可共存, 由 Resolver 裁决)
    if (deps.tailwindcss || deps.unocss || has(/^tailwind\.config\.(js|ts|cjs|mjs)$/) || has(/^uno\.config\.(js|ts|cjs|mjs)$/) || has(/^unocss\.config\.(js|ts|cjs|mjs)$/)) {
      if (deps.unocss || has(/^uno\.config/ ) || has(/^unocss\.config/)) push(facts.styling, 'unocss', deps.unocss ? 0.92 : 0.85, deps.unocss ? 'package.json:unocss' : 'uno.config.*')
      else push(facts.styling, 'tailwind', deps.tailwindcss ? 0.96 : 0.85, deps.tailwindcss ? 'package.json:tailwindcss' : 'tailwind.config.*')
    }
    if (deps['styled-components']) push(facts.styling, 'styled-components', 0.9, 'package.json:styled-components')
    if (deps['@emotion/react'] || deps['@emotion/styled']) push(facts.styling, 'emotion', 0.88, 'package.json:@emotion/*')
    if (deps['@vanilla-extract/css'] || deps['@vanilla-extract/webpack-plugin']) push(facts.styling, 'vanilla-extract', 0.9, 'package.json:@vanilla-extract/css')
    if (deps.sass || deps['node-sass'] || has(/\.scss$/)) push(facts.styling, 'scss', deps.sass ? 0.85 : 0.6, deps.sass ? 'package.json:sass' : '*.scss')
    if (deps.less || has(/\.less$/)) push(facts.styling, 'less', deps.less ? 0.8 : 0.55, 'less')
    const moduleCss = files.filter((f: any) => /\.module\.css$/.test(f))
    if (moduleCss.length) push(facts.styling, 'css-modules', 0.85, `${moduleCss.length} 个 *.module.css`)
    const plainCss = files.filter((f: any) => /^[^/]*\.css$/.test(f) && !/tailwind/.test(f))
    if (plainCss.length) push(facts.styling, 'plain-css', 0.6, '根级 *.css(非 module)')
    if (deps['css-modules'] || deps['typings-for-css-modules-loader']) push(facts.styling, 'css-modules', 0.8, 'package.json')
    // shadcn/ui 仅通过 components.json 声明，属 styling 约定而非 framework，需单独探测
    if (exists(path.join(projectDir, 'components.json'))) {
      const compJson = readJson(path.join(projectDir, 'components.json'))
      if (compJson && (compJson.style || compJson.tailwind)) push(facts.styling, 'tailwind', 0.88, 'components.json:shadcn');
      (facts.notes as any).push('components.json 存在，疑似 shadcn/ui')
    }

    // build
    if (has(/^vite\.config\.(ts|js|mjs|cjs)$/)) push(facts.build, 'vite', 0.97, 'vite.config.*')
    if (has(/^webpack\.config\.(ts|js|mjs|cjs)$/) || deps['react-scripts']) push(facts.build, deps['react-scripts'] ? 'cra' : 'webpack', deps['react-scripts'] ? 0.9 : 0.85, 'webpack 证据')
    if (deps.next) push(facts.build, 'next', 0.95, 'package.json:next')

    // componentLibraries
    for (const lib of ['antd', '@mui/material', '@chakra-ui/react', 'element-plus', '@arco-design/web-react', 'semi-ui', '@douyinfe/semi-ui']) {
      if (deps[lib]) push(facts.componentLibraries, lib, 0.97, `package.json:${lib}`)
    }
    // 入口
    facts.entry.html = files.find((f: any) => /^index\.html$/.test(f) || /^public\/index\.html$/.test(f))
    facts.entry.main = files.find((f: any) => /^src\/main\.(t|j)sx?$/.test(f)) || files.find((f: any) => /^src\/index\.(t|j)sx?$/.test(f))
  }

  // ---- Flutter ----
  if (exists(path.join(projectDir, 'pubspec.yaml'))) {
    const pubspec = readText(path.join(projectDir, 'pubspec.yaml'))
    push(facts.framework, 'flutter', 0.99, 'pubspec.yaml')
    push(facts.language, 'dart', 1, 'pubspec.yaml')
    if (/flutter_svg/.test(pubspec)) push(facts.componentLibraries, 'flutter_svg', 0.9, 'pubspec:flutter_svg')
  }
  // ---- 小程序 ----
  if (exists(path.join(projectDir, 'app.json')) && has(/\.wxml$/)) {
    push(facts.framework, 'miniprogram', 0.95, 'app.json + *.wxml')
    push(facts.language, 'javascript', 0.85, '小程序默认')
  }
  // ---- iOS ----
  const swiftFiles = files.filter((f: any) => /\.swift$/.test(f))
  if (swiftFiles.length || has(/\.xcodeproj\//)) {
    push(facts.framework, 'ios', 0.9, '*.swift / xcodeproj')
    push(facts.language, 'swift', 1, '*.swift')
    if (swiftFiles.some((f: any) => /import\s+SwiftUI/.test(readText(path.join(projectDir, f))))) {
      push(facts.framework, 'swiftui', 0.85, 'import SwiftUI')
    }
  }
  return facts
}
