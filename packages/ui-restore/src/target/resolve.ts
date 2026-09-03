// target/resolve.ts — Resolver(做决策): Facts → 唯一 Target Profile
//
// 与 Analyzer 的分界: 本模块才允许「因此选什么」。缺证据 → 'unknown',
// 绝不默认 css-modules/tailwind 等具体方案(v4 §4 修正 v3 的两个过度断言)。
// unknown 的下游语义由消费方(contract/emit)以安全路径承接, 不阻塞流程。
import path from 'node:path'
import { detectProjectFacts } from './detect.ts'
import { RESOLVE_MIN_CONFIDENCE } from './types.ts'
import type { ProjectFacts, TargetProfile, Candidate, Decision } from './types.ts'

const UNKNOWN = 'unknown'

function pick(list: any, opts: Record<string, any> = {}) {
  // 显式覆盖优先(用户输入 > 探测), 溯源标记 explicit
  if (opts.overrides != null && opts.overrides !== '') {
    return { chosen: opts.overrides, decision: { chosen: opts.overrides, because: '显式指定', confidence: 1 } }
  }
  const top = (list || [])[0]
  if (!top || top.confidence < (opts.min ?? RESOLVE_MIN_CONFIDENCE)) {
    return { chosen: opts.unknown ?? UNKNOWN, decision: { chosen: opts.unknown ?? UNKNOWN, because: top ? `最高候选 ${top.name} 置信度 ${top.confidence} 低于阈值` : '无观察证据', confidence: top?.confidence ?? 0 } }
  }
  return { chosen: top.name, decision: { chosen: top.name, because: top.evidence || '观察证据', confidence: top.confidence } }
}

/**
 * Facts → Target Profile。
 * @param {ProjectFacts} facts
 * @param {object} [opts] overrides: 显式指定某维(用户输入优先于探测); assetDir 覆盖
 */
export function resolveProfile(facts: any, opts: Record<string, any> = {}) {
  const o = opts.overrides || {}
  const framework = pick(facts.framework, { overrides: o.framework })
  const language = pick(facts.language, { unknown: 'javascript', overrides: o.language }) // js 是任意构建器都可跑的安全底
  const styling = pick(facts.styling, { overrides: o.styling }) // unknown 不二次加工 — 偷偷默认 = 改技术栈
  const build = pick(facts.build, { unknown: 'none', overrides: o.build })
  const libs = (facts.componentLibraries || []).filter((c: any) => c.confidence >= RESOLVE_MIN_CONFIDENCE).map((c: any) => c.name)

  // assetDir: vite/next 用 public/*(静态直出), 其余 src/assets; 显式覆盖最高
  const assetDir = o.assetDir || (['vite', 'next'].includes(build.chosen) ? 'public/restore-assets' : 'src/assets')

  const profile = {
    framework: framework.chosen,
    language: language.chosen,
    styling: styling.chosen,
    build: build.chosen,
    componentLibraries: libs,
    // TYPO(P0): 字体策略 —— 设计稿主字体(PingFang SC 系) + 等价系统栈; webFonts 由 assets 回填
    fonts: { fallbackStack: ['PingFang SC', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'], webFonts: [] },
    assetDir,
    decisions: {
      framework: framework.decision,
      language: language.decision,
      styling: styling.decision,
      build: build.decision,
      assetDir: { chosen: assetDir, because: o.assetDir ? '显式指定' : `build=${build.chosen} 的静态资源约定`, confidence: o.assetDir ? 1 : build.decision.confidence },
    },
  }
  // overrides 落溯源(谁改的为什么)
  for (const k of Object.keys(o)) {
    if (k === 'assetDir') continue
    if ((profile.decisions as any)[k] && (profile as any)[k] === o[k]) (profile.decisions as any)[k] = { chosen: o[k], because: '显式指定', confidence: 1 }
  }
  return profile
}

/** 便捷入口: 项目目录 → (facts, profile)。Analyzer 结果一并返回供审计。 */
export function analyzeProject(projectDir: any, opts: Record<string, any> = {}) {
  const facts = detectProjectFacts(projectDir)
  const profile = resolveProfile(facts, opts)
  return { facts, profile }
}
