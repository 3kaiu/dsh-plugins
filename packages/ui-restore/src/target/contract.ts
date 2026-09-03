// target/contract.ts — P0-2 Generation Contract(+ TYPO 字体策略)
//
// 定义「每个 Blueprint 能力在目标栈怎么实现」的**决策**, 而非能力清单:
//   layout.role(设计语义) → layout.strategy(实现策略) → 目标实现(emit)
//   决不写死 row→display:flex 的语义等价映射 —— flex 是策略, 不是翻译。
//
// 策略选择规则(V1):
//   layout: stack/absolute → 'absolute'(安全路径); row/column 且 confidence>=0.7 → 'flex';
//           低置信 row/column → 'absolute'(Flex 无法准确表达时用 absolute 是正确答案);
//           grid/flow 预留 V1 不产生。
//   paint:  fill.image → 'asset'; svgKey → 'svg'; 其余 → 'css'
//   typography: textRuns → 'rich-text'; 普通 text → 'native'
//   component: ⑱ Library Mapping：profile.componentLibraries 命中且启发式高置信时 → 'library'，否则 'native'
import type { TargetProfile } from './types.ts'
import { mapToLibrary } from './component-map.ts'

/** 蓝图节点的结构子集(只声明本模块消费的字段) */
export interface ContractNode {
  id: string
  name?: string
  type?: string
  text?: string
  textRuns?: unknown[]
  svgKey?: string
  fontFamily?: string
  fontSize?: number
  fontWeight?: number
  lineHeight?: number
  letterSpacing?: number
  softWrap?: boolean
  maxLines?: number
  bounds?: { x: number; y: number; width: number; height: number }
  fill?: { type?: string; src?: string }
  layout?: { role?: string; position?: string; confidence?: number; clip?: { enabled?: boolean } }
  children?: ContractNode[]
}

/** 单节点生成决策(v4 §4 P0-2 契约形状) */
export interface GenerationContractItem {
  nodeId: string
  layout: { strategy: 'flex' | 'absolute' | 'grid' | 'flow' }
  paint: { strategy: 'css' | 'asset' | 'svg' }
  typography: { strategy: 'native' | 'rich-text'; softWrap?: boolean; maxLines?: number }
  component: { strategy: 'native' | 'library'; name?: string }
  /** 容器裁剪决策(clip.enabled → overflow:hidden; 可选字段, 向后兼容) */
  container?: { clip: 'overflow-hidden' | 'none' }
  asset?: { kind: 'image' | 'svg'; key: string; source?: string }
}

export interface FontDecision {
  /** 设计稿声明字体 */
  family: string
  /** emit 实际使用的 font-family 栈(设计字体优先, profile 栈兜底) */
  resolvedStack: string[]
  weights: number[]
  /** 设计字体不在 profile 可用栈 → 环境风险, 不允许误判为 CSS bug(见 errors.ts TYPOGRAPHY) */
  webFontNeeded: boolean
}

export interface GenerationPlan {
  items: GenerationContractItem[]
  byId: Map<string, GenerationContractItem>
  fonts: FontDecision[]
  /** 未解决资产(svgKey 无导出源 / image 无 src) —— emit 侧禁止近似替代, 必须显式占位并计入违约 */
  unresolvedAssets: { nodeId: string; kind: string; key: string }[]
  warnings: string[]
}

const FLEX_MIN_CONFIDENCE = 0.7

/** 蓝图(子树) + Target Profile → Generation Plan */
export function planGeneration(bp: any, profile: any, opts: Record<string, any> = {}) {
  const items: any[] = []
  const fontMap = new Map()
  const unresolvedAssets: any[] = []
  const warnings: any[] = []
  const flexMin = opts.flexMinConfidence ?? FLEX_MIN_CONFIDENCE

  const decide = (n: any) => {
    const ly = n.layout || {}
    // layout: 设计语义 → 实现策略
    let strategy = 'absolute'
    if (ly.role === 'row' || ly.role === 'column') {
      if ((ly.confidence ?? 0) >= flexMin) strategy = 'flex'
      else warnings.push(`${n.id}: ${ly.role} 置信度 ${ly.confidence ?? '缺省'} < ${flexMin} → absolute 保真`)
    }
    // paint: 能力 → 通道
    let paint = 'css'
    let asset
    if (n.fill?.type === 'image') {
      paint = 'asset'
      asset = { kind: 'image', key: n.fill.src || n.id }
      if (!n.fill.src) unresolvedAssets.push({ nodeId: n.id, kind: 'image', key: n.id })
    } else if (n.svgKey) {
      paint = 'svg'
      asset = { kind: 'svg', key: n.svgKey }
      unresolvedAssets.push({ nodeId: n.id, kind: 'svg', key: n.svgKey }) // 由 asset-resolver 消化, 未消化则保留
    } else if ((n as any).mergedVector) {
      // 合并矢量: 无 svgKey, 必须按节点 id 从设计侧导出后渲染, 禁止留空或形状近似替代
      paint = 'svg'
      asset = { kind: 'svg', key: n.id }
      unresolvedAssets.push({ nodeId: n.id, kind: 'svg', key: n.id })
    }
    // typography
    const typography = n.textRuns?.length
      ? { strategy: 'rich-text' }
      : { strategy: 'native', softWrap: n.softWrap, maxLines: n.maxLines }
    // ⑱ component library 映射（保守，仅高置信）
    let component: GenerationContractItem['component'] = { strategy: 'native' }
    const libHit = mapToLibrary(n, profile as any)
    if(libHit) component = { strategy: 'library', name: libHit.component }
    const item = {
      nodeId: n.id,
      layout: { strategy },
      paint: { strategy: paint },
      typography,
      component,
      container: { clip: ly.clip?.enabled ? 'overflow-hidden' : 'none' },
      ...(asset ? { asset } : {}),
    } as GenerationContractItem
    // 记录映射原因供 emit 侧取 props
    if(libHit) (item as any)._library = libHit
    items.push(item)
    // TYPO(P0): 字体观察 —— 设计稿声明字体 → 解析栈; 不在 profile 栈 = 环境风险
    if (typeof n.text === 'string' && n.text) {
      const fam = n.fontFamily || 'system'
      if (!fontMap.has(fam)) {
        const inStack = (profile.fonts?.fallbackStack || []).includes(fam)
        fontMap.set(fam, {
          family: fam,
          resolvedStack: [fam, ...(profile.fonts?.fallbackStack || [])].filter((v, i, a) => a.indexOf(v) === i),
          weights: new Set(),
          webFontNeeded: !inStack && fam !== 'system',
        })
        if (!inStack && fam !== 'system') warnings.push(`字体 ${fam} 不在 profile 可用栈 → 文本宽度/换行可能连锁偏移, 归因 TYPOGRAPHY-font(环境) 而非 CSS`)
      }
      fontMap.get(fam).weights.add(n.fontWeight ?? 400)
    }
    for (const c of n.children || []) decide(c)
  }
  for (const r of [...(bp?.tree || []), ...(bp?.floatings || [])]) decide(r)

  const fonts = [...fontMap.values()].map((f: any) => ({ ...f, weights: [...f.weights].sort((a: any, b: any) => a - b) }))
  const byId = new Map(items.map((i: any) => [i.nodeId, i]))
  return { items, byId, fonts, unresolvedAssets, warnings }
}
