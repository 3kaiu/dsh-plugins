// target/types.ts — Target 层类型契约(v4 方案 §4 Project Analyzer: Facts + Resolver)
//
// 职责分界(审计锚点):
//   detect.ts (Analyzer)  只回答「观察到什么」—— 置信度排序候选, 不做单一断言
//   resolve.ts (Resolver) 只回答「因此选什么」—— 消费 Facts 产出唯一 Target Profile
//   LLM 参与项目理解时只允许补充 evidence, 不允许直接写 Facts

/** 置信度排序候选(0~1, 降序由 detect 保证) */
export interface Candidate {
  name: string
  confidence: number
  /** 观察证据(哪个文件/依赖触发了本候选) */
  evidence?: string
}

/** 项目观察事实(全候选列表, 不含决策) */
export interface ProjectFacts {
  framework: Candidate[]
  language: Candidate[]
  styling: Candidate[]
  build: Candidate[]
  componentLibraries: Candidate[]
  /** 观察到的入口(相对项目根) */
  entry: { html?: string; main?: string }
  /** 附加观察(fonts 目前面板不可静态探测, 预留) */
  notes?: string[]
}

/** 单项决策溯源 */
export interface Decision {
  chosen: string
  because: string
  confidence: number
}

/**
 * Target Profile — Resolver 的唯一决策产物。
 * styling 允许 'unknown': 绝不默认 css-modules/tailwind(避免偷偷改技术栈),
 * unknown 时 emit 侧走内联样式安全路径(见 contract.ts)。
 */
export interface TargetProfile {
  framework: string
  language: string
  styling: string
  build?: string
  componentLibraries: string[]
  /** TYPO(P0): 字体策略 —— fallbackStack 至少含设计稿主字体与等价系统栈 */
  fonts: { fallbackStack: string[]; webFonts: { family: string; source: string }[] }
  /** 资源落盘目录(相对项目根) */
  assetDir: string
  /** 每项决策的溯源(为什么选它) */
  decisions: Record<'framework' | 'language' | 'styling' | 'build' | 'assetDir', Decision>
}

/** 低于此置信度视为未观察到(→ unknown) */
export const RESOLVE_MIN_CONFIDENCE = 0.5
