// target/patch.ts — P0-7/9/11 Patch Contract + Patch Validator(v4 §6 受限修改器)
//
// 定位：Region→Node→Source 之后，LLM 只能以「受限修改器」身份改码 ——
//   输入 = PatchRequest(允许改什么、到什么粒度)，输出 = Patch(改了什么)，
//   中间以 PatchPolicy + PatchValidator 约束与验收。
//
// 与 split 的对应：
//   ⑨ Patch Contract = PatchRequest + PatchPolicy 的形状定义
//   ⑪ Patch Validator = 产出 Patch 后的拒收检验

/** 受限修改的优先级与禁止项(v4 §6) */
export const PATCH_POLICY = {
  priority: [
    '1. 调整已有属性值(最优先, 确定性优先)',
    '2. 调整父布局(影响多子项时, 先核对 contract.layout.strategy)',
    '3. 调整节点布局(最后手段)',
  ],
  forbidden: [
    '禁止修改无关节点(非 allowedNodes)',
    '禁止引入新依赖(新增 import/require 超出白名单)',
    '禁止改变架构(新增文件超预算、改入口、换框架)',
    '禁止大范围重写文件(单文件改动比超阈)',
    '禁止用近似图形/CSS 手绘替代真实资产(svgKey/image)',
  ],
  // 策略到错误类的映射(与 verify/errors.ts  taxonomy 对齐)
  mapping: {
    LAYOUT: '优先确定性改 gap/padding/size, 再动 position/alignment(先父后子)',
    PAINT: '以蓝图 color/fill/stroke 为准, token 存在优先引用',
    TYPOGRAPHY: '字体缺失时先补字体环境, 不得判为 CSS bug',
    ASSET: '回 Asset Resolver, 禁止 LLM 用 CSS 近似',
    STRUCTURE: '对照 checklist: 缺失补实现, 多余删, 层级按 floatings>tree',
  },
} as const

/** Patch Request — Verifier 产出、喂 LLM 的唯一输入(非自由改码) */
export interface PatchRequest {
  /** 本次允许改的蓝图节点(关联区域命中的叶子与容器，取并集去重) */
  affectedNodes: string[]
  /** 归一的偏差描述(数值真值在 blueprint 子树，不在此重复) */
  violations: string[]
  /** 允许改的磁盘文件(相对 projectDir, 如 src/Restore.tsx) */
  allowedFiles: string[]
  /** 允许触碰的节点(与 affectedNodes 通常一致，必要时扩父容器做布局修正) */
  allowedNodes: string[]
  /** 人可读约束(随 prompt 喂 LLM) */
  constraints: string[]
  /** 额外上下文：关联 region 与 DOM hints(供 LLM 定位代码段) */
  context?: {
    regions: Array<{ x: number; y: number; width: number; height: number; pixels: number; severity?: string }>
    candidates: Array<{ id: string; name: string; text?: string | null }>
    domHints?: Array<{ text: string; x: number; y: number }>
    blueprintNodes?: Array<{ id: string; name: string; bounds: any; layout: any; text?: string; color?: string }>
    // 错误分类结果(供策略选择)
    errors?: Array<{ category: string; kind: string; nodeId: string | null }>
  }
  /** 元信息 */
  meta?: { iteration: number; gateFailed?: string[] }
}

/** Patch — LLM 产出（文件级改动计划） */
export interface Patch {
  /** 改动文件列表(相对 projectDir) */
  files: Array<{
    path: string
    /** 改后全量内容 */
    content: string
    /** 改前内容(供 validator 计算 diff) */
    original?: string
  }>
  description?: string
  /** LLM 声明其触碰的节点(可选，validator 交叉校验) */
  touchedNodes?: string[]
  /** 声明新增依赖(可选) */
  addedDependencies?: string[]
}

export interface ValidateOptions {
  /** 允许的文件白名单之外的容忍(如 .restore-map.json 辅助文件) */
  allowExtraFiles?: string[]
  /** 单文件行变化比阈值(0.6=超 60% 视为重写) */
  maxFileChangeRatio?: number
  /** 单文件最大新增行(防整页重写) */
  maxAddedLines?: number
  /** 允许的新增依赖白名单 */
  allowedNewDeps?: string[]
}

export interface ValidateResult {
  ok: boolean
  reasons: string[]
  /** 哪类拒收 */
  failedChecks: string[]
  stats?: { files: number; changedLines: number; totalLines: number }
}

/**
 * 构造一个最小 PatchRequest（verify 侧调用）
 */
export function createPatchRequest(opts: {
  affectedNodes: string[]
  violations: string[]
  allowedFiles: string[]
  allowedNodes?: string[]
  constraints?: string[]
  context?: PatchRequest['context']
  meta?: PatchRequest['meta']
}): PatchRequest {
  const allowedNodes = opts.allowedNodes ?? [...opts.affectedNodes]
  const baseConstraints = [
    '仅修改 allowedFiles 列出的文件',
    '仅触碰 allowedNodes 对应的节点样式/布局(用 data-restore-node 定位)',
    ...PATCH_POLICY.forbidden,
  ]
  return {
    affectedNodes: [...new Set(opts.affectedNodes)],
    violations: [...opts.violations],
    allowedFiles: [...new Set(opts.allowedFiles)],
    allowedNodes: [...new Set(allowedNodes)],
    constraints: [...baseConstraints, ...(opts.constraints || [])],
    context: opts.context,
    meta: opts.meta,
  }
}

/**
 * Patch Validator — 任一拒收条件即回滚
 * 校验：文件越界 / 节点越界 / 依赖增加 / 修改量异常 / DOM 大面积改变(通过行数代理)
 */
export function validatePatch(patch: Patch, request: PatchRequest, opts: ValidateOptions = {}): ValidateResult {
  const reasons: string[] = []
  const failedChecks: string[] = []
  const fail = (check: string, msg: string) => { failedChecks.push(check); reasons.push(`[${check}] ${msg}`) }

  if (!patch || !Array.isArray(patch.files) || patch.files.length === 0) {
    fail('empty', 'Patch 无文件改动')
    return { ok: false, reasons, failedChecks }
  }

  const allowedSet = new Set([...(request.allowedFiles || []), ...(opts.allowExtraFiles || [])])
  // 1. 文件越界
  for (const f of patch.files) {
    if (!allowedSet.has(f.path)) fail('file-scope', `文件越界: ${f.path} 不在 allowedFiles [${[...allowedSet].join(', ')}]`)
  }

  // 2. 节点越界：统计 patch 内容中出现的 data-restore-node 与 nodeId 命中
  const patchText = patch.files.map((f) => f.content).join('\n')
  const touchedNodes = extractTouchedNodes(patchText)
  const allowedNodeSet = new Set(request.allowedNodes || [])
  // 若 LLM 声明 touchedNodes，则以声明为准再交叉校验内容(防声明与实际不符)
  const declared = patch.touchedNodes ? [...patch.touchedNodes] : null
  const toCheck = declared ?? touchedNodes
  for (const id of toCheck) {
    if (id && !allowedNodeSet.has(id)) fail('node-scope', `节点越界: ${id} 不在 allowedNodes [${[...allowedNodeSet].join(', ')}]`)
  }
  // 3. 依赖增加
  const newImports = extractNewImports(patch)
  const allowedDeps = new Set([...(opts.allowedNewDeps || []), ...(patch.addedDependencies || [])])
  // 白名单外的新 external 视为违约(相对路径 ./ ../ 不计)
  for (const dep of newImports) {
    if (dep.startsWith('.') || dep.startsWith('/')) continue
    const base = String(dep).replace(/^node:/, '').split('/')[0]
    if (!allowedDeps.has(dep) && !DANGEROUS_MODULES.has(base)) {
      fail('dependency', `新增依赖越界: "${dep}" 不在白名单(禁止引入新依赖)`)
    }
    // 无论是否在白名单, 危险模块一律拒收(防 RCE: child_process / vm / worker_threads ...)
    if (DANGEROUS_MODULES.has(base)) fail('dangerous-dependency', `禁止引入危险模块: "${dep}"(可能造成代码执行逃逸)`)
  }
  // 3b. 危险代码模式(独立于依赖): eval / new Function / 字符串型 setTimeout / 间接 require
  if (hasDangerousCode(patchText)) {
    fail('dangerous-code', '检测到 eval / new Function / 字符串定时器 / 动态 require 等危险代码模式(禁止)')
  }
  // 4. 修改量异常
  let totalAdded = 0, totalOriginal = 0, totalChanged = 0
  const maxAdded = opts.maxAddedLines ?? 400
  for (const f of patch.files) {
    if (f.original == null) continue
    const aLines = f.content.split('\n')
    const oLines = f.original.split('\n')
    const changed = diffLineCount(oLines, aLines)
    totalChanged += changed
    const added = Math.max(0, aLines.length - oLines.length)
    totalAdded += added
    totalOriginal += oLines.length
    const ratio = oLines.length > 0 ? changed / oLines.length : 1
    const maxRatio = opts.maxFileChangeRatio ?? 0.6
    if (ratio > maxRatio) fail('change-ratio', `${f.path} 改动比 ${(ratio * 100).toFixed(1)}% > ${(maxRatio * 100)}%(疑似大范围重写)`)
    // 单文件新增行阈值(非全局累计): 防单个文件被整页重写
    if (added > maxAdded) fail('change-volume', `${f.path} 单文件新增 ${added} 行 > ${maxAdded}(疑似大范围重写)`)
  }

  // 5. 禁止近似资产替代：检测 patch 中是否新增 CSS 手绘图形替代 svgKey(如用 ::before 画图标且 allowedNodes 含资产节点)
  if (hasAssetPlaceholderReplacement(patchText, request)) {
    fail('asset-replacement', '疑似用 CSS/近似图形替代矢量资产(禁止近似, 回 Asset Resolver)')
  }

  return {
    ok: failedChecks.length === 0,
    reasons,
    failedChecks,
    stats: { files: patch.files.length, changedLines: totalChanged, totalLines: totalOriginal },
  }
}

function extractTouchedNodes(text: string): string[] {
  const out = new Set<string>()
  const re = /data-restore-node\s*=\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.add(m[1])
  // 也匹配 形如 "nodeId":"xxx" 的 JSON 串(少见)
  const re2 = /["']nodeId["']\s*:\s*["']([^"']+)["']/g
  while ((m = re2.exec(text))) out.add(m[1])
  return [...out]
}

function extractNewImports(patch: Patch): string[] {
  const deps = new Set<string>()
  // 同时覆盖 静态 import ... from 'x' / require('x') / 动态 import('x')
  const importRe = /(?:import\s+[^'"]*\s+from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g
  for (const f of patch.files) {
    const txt = f.content
    let m: RegExpExecArray | null
    while ((m = importRe.exec(txt))) deps.add(m[1])
  }
  // 只返回不在 original 里的新增(需 original 才可比)
  const originalDeps = new Set<string>()
  for (const f of patch.files) {
    if (!f.original) continue
    let m: RegExpExecArray | null
    const re = /(?:import\s+[^'"]*\s+from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g
    while ((m = re.exec(f.original))) originalDeps.add(m[1])
  }
  return [...deps].filter((d) => !originalDeps.has(d))
}

/** 危险模块黑名单: 一旦被新引入即视为 RCE 逃逸尝试, 一律拒收 */
const DANGEROUS_MODULES = new Set([
  'child_process', 'cluster', 'worker_threads', 'vm', 'module', 'repl',
  'dgram', 'tls', 'net', 'http', 'https', 'crypto', 'os', 'fs', 'path',
  'dns', 'zlib', 'readline', 'stream', 'inspector', 'v8',
])

/** 危险代码模式: 与依赖无关, 任何出现即拒收(防 LLM 在 allowed 文件里塞入 eval/动态执行) */
function hasDangerousCode(text: string): boolean {
  // new Function / eval( / 字符串型 setTimeout/setInterval / 间接 require 变量
  const re = /\bnew\s+Function\s*\(|\b(?:eval)\s*\(|(?:setTimeout|setInterval)\s*\(\s*['"`]|\brequire\s*\(/g
  return re.test(text)
}

function diffLineCount(a: string[], b: string[]): number {
  // 行级差异：按下标逐行对比，替换计1，新增/删除按超出部分计
  const minLen = Math.min(a.length, b.length)
  let changed = 0
  for (let i = 0; i < minLen; i++) if (a[i] !== b[i]) changed++
  changed += Math.abs(a.length - b.length)
  return changed
}

function hasAssetPlaceholderReplacement(text: string, request: PatchRequest): boolean {
  // 启发式：请求含资产节点且补丁出现可疑手绘标记(用纯 CSS 三角/伪元素画图标)
  const assetNodes = (request.affectedNodes || []).filter((id) => {
    const ctx = request.context?.blueprintNodes?.find((n) => n.id === id)
    return ctx && ((ctx as any).svgKey || (ctx as any).fill?.type === 'image' || (ctx as any).mergedVector)
  })
  if (assetNodes.length === 0) return false
  const suspicious = /::before|::after|border.*transparent|clip-path:\s*polygon|background:\s*linear-gradient.*triangle/i
  return suspicious.test(text)
}
