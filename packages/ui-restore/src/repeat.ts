// repeat.ts - 重复结构(repeater)检测
// 目标: 在拍平设计稿中找出"同构兄弟序列"(列表项/标签组/卡片列表),
// 让下游 codegen 生成列表循环而非 N 份拷贝,同时压缩结构描述 token。
//
// 不依赖 MasterGo 的 structureHash 字段(原始 DSL 中不存在),
// 而是自行计算结构指纹: 类型 + 尺寸桶 + 视觉信号 + 子树递归指纹。
// 文本内容只参与"存在性/粗粒度长度桶",不参与精确匹配 --
// 列表项文本各不相同,正是需要归一化的部分。

const round = (n) => Math.round((n || 0) * 100) / 100

// 尺寸桶: 4px 容差,吸收设计稿 1-2px 的手工误差
function sizeBucket(n) {
  return n == null ? '?' : Math.round(n / 4)
}

// 文本信号: 存在性 + 粗粒度长度桶(16 字符),忽略具体内容
function textSignal(node) {
  let t = null
  if (typeof node.text === 'string') t = node.text
  else if (Array.isArray(node.text)) t = node.text.map((x) => (x && x.text) || '').join('')
  if (t == null || t === '') return null
  return 'len' + Math.round(t.length / 16)
}

// 颜色信号: 直接可读的颜色值(清洗后 DSL 的 _color / 原生 fill / 蓝图 color)
function colorSignal(node) {
  if (typeof node._color === 'string' && node._color) return node._color
  if (typeof node.color === 'string' && node.color) return node.color
  if (typeof node.fill === 'string' && node.fill && !/^paint_/.test(node.fill)) return node.fill
  return null
}

/**
 * 节点结构指纹(递归)。相同指纹 => 结构同构,可视为同一重复项的实例。
 * 刻意忽略: 绝对/相对坐标、具体文案、id、name。
 */
export function structureFingerprint(node, opts = {}) {
  if (!node) return 'null'
  // 形状兼容: 清洗后 DSL(layoutStyle) 与蓝图节点(bounds/layout)双形态
  const ls = node.layoutStyle || {}
  const w = ls.width ?? node.bounds?.width
  const h = ls.height ?? node.bounds?.height
  const parts = [node.type || 'NODE', sizeBucket(w), sizeBucket(h)]
  const color = colorSignal(node)
  if (color) parts.push('c:' + color)
  const radius = node.borderRadius ?? node.layout?.borderRadius
  if (radius) parts.push('r:' + (Array.isArray(radius) ? radius.join('-') : radius))
  if (ls.rotate) parts.push('rot:' + Math.round(ls.rotate))
  const ts = textSignal(node)
  if (ts) parts.push('t:' + ts)
  const kids = node.children || []
  if (kids.length) {
    const kidFps = kids.map((k) => structureFingerprint(k, opts))
    // 顺序无关: 同构判定不应依赖子节点排列顺序(几何聚类顺序因位置而异)
    parts.push('[' + (opts?.sortChildren ? kidFps.sort().join(',') : kidFps.join(',')) + ']')
  }
  return parts.join('|')
}

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : round((s[mid - 1] + s[mid]) / 2)
}

/**
 * 测量重复组的轴向/间距/单项尺寸。
 * axis: 相邻 item 的主位移在 x 还是 y;gap 为同边间距差的中位数。
 */
function measureGroup(items) {
  const first = items[0].layoutStyle || {}
  const dxs = []
  const dys = []
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1].layoutStyle || {}
    const b = items[i].layoutStyle || {}
    dxs.push((b.relativeX || 0) - (a.relativeX || 0))
    dys.push((b.relativeY || 0) - (a.relativeY || 0))
  }
  const spanX = Math.max(...dxs.map(Math.abs), 0)
  const spanY = Math.max(...dys.map(Math.abs), 0)
  const axis = spanX >= spanY ? 'row' : 'column'
  const gaps = []
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1].layoutStyle || {}
    const b = items[i].layoutStyle || {}
    if (axis === 'row') gaps.push((b.relativeX || 0) - ((a.relativeX || 0) + (a.width || 0)))
    else gaps.push((b.relativeY || 0) - ((a.relativeY || 0) + (a.height || 0)))
  }
  return {
    axis,
    itemWidth: round(first.width || 0),
    itemHeight: round(first.height || 0),
    gap: median(gaps.map((g) => round(g))),
  }
}

/**
 * 在兄弟节点序列中检测连续同构重复组。
 * @param {Array} nodes 兄弟节点(需含 layoutStyle.relativeX/Y/width/height)
 * @param {object} [opts] min: 最小重复数(默认 3)
 * @returns {Array<{startIndex:number, count:number, itemIds:Array, axis:string, itemWidth:number, itemHeight:number, gap:number}>}
 */
export function detectRepeatGroups(nodes, opts = {}) {
  const min = opts.min || 3
  const list = nodes || []
  const fps = list.map(structureFingerprint)
  const groups = []
  let i = 0
  while (i < list.length) {
    let j = i
    while (j + 1 < list.length && fps[j + 1] === fps[i]) j++
    const count = j - i + 1
    if (count >= min) {
      const items = list.slice(i, j + 1)
      // 无子节点且无文本无填充的纯占位重复(如等距分隔条)也允许,只要同构
      groups.push({
        startIndex: i,
        count,
        itemIds: items.map((n) => n.id),
        ...measureGroup(items),
      })
    }
    i = j + 1
  }
  return groups
}

/**
 * 跨 section 共享组件检测: 对多个(清洗后)结构树做全局指纹聚类,
 * 找出在 >= minSections 个 section 中复用的同构子树(可提炼为公共组件)。
 *
 * 与 detectRepeatGroups(容器内兄弟序列)互补:
 * - 后者服务"列表循环"压缩,作用于单一父容器;
 * - 本函数服务"组件复用"发现,作用于跨 section/跨页面的全局空间。
 *
 * 刻意只索引"有子节点的容器"(叶子矩形/图标遍地同构,无组件价值);
 * 嵌套去重: 大容器成组后其内部子树不再重复上报。
 *
 * @param {Array<Array>} trees 每个 section 的顶层节点数组(需含 layoutStyle 与 children)
 * @param {object} [opts] minSections: 至少出现的 section 数(默认 2)
 * @returns {Array<{fingerprint, count, sections:Array<number>, itemWidth, itemHeight, instances:Array<{sectionIndex,id,name,x,y}>}>}
 */
export function detectSharedComponents(trees, opts = {}) {
  const minSections = opts.minSections || 2
  const byFp = new Map()
  // 深度优先索引: 只收有子节点的容器
  const index = (node, sectionIndex) => {
    if (!node || !Array.isArray(node.children) || node.children.length === 0) return
    const ls = node.layoutStyle || {}
    const fp = structureFingerprint(node)
    if (!byFp.has(fp)) byFp.set(fp, [])
    byFp.get(fp).push({
      sectionIndex,
      id: node.id,
      name: node.name || '',
      x: ls.relativeX ?? ls.x ?? 0,
      y: ls.relativeY ?? ls.y ?? 0,
      width: ls.width || 0,
      height: ls.height || 0,
      _node: node,
    })
    for (const c of node.children) index(c, sectionIndex)
  }
  ;(trees || []).forEach((roots, si) => {
    for (const r of roots || []) index(r, si)
  })

  // 候选: 出现在 >= minSections 个不同 section
  const candidates = []
  for (const [fp, instances] of byFp) {
    const sections = [...new Set(instances.map((i) => i.sectionIndex))]
    if (sections.length >= minSections) candidates.push({ fp, instances, sections })
  }
  // 面积降序: 大组件优先成组,嵌套小容器随后被去重
  candidates.sort((a, b) => {
    const area = (arr) => arr.reduce((s, i) => s + (i.width || 0) * (i.height || 0), 0) / arr.length
    return area(b.instances) - area(a.instances)
  })

  const reported = []
  const consumed = new Set() // 已归组子树的节点 id(嵌套去重)
  const markSubtree = (node, set) => {
    if (!node) return
    set.add(node.id)
    for (const c of node.children || []) markSubtree(c, set)
  }
  for (const cand of candidates) {
    const live = cand.instances.filter((i) => !consumed.has(i.id))
    const liveSections = [...new Set(live.map((i) => i.sectionIndex))]
    if (liveSections.length < minSections) continue
    for (const i of live) markSubtree(i._node, consumed)
    reported.push({
      fingerprint: cand.fp,
      count: live.length,
      sections: liveSections,
      itemWidth: round(live[0].width || 0),
      itemHeight: round(live[0].height || 0),
      instances: live.map(({ sectionIndex, id, name, x, y }) => ({ sectionIndex, id, name, x: round(x), y: round(y) })),
    })
  }
  return reported
}

/**
 * 同构兄弟组件组检测 (detectSiblingComponentGroups)
 * 在蓝图树的每一层兄弟间按结构指纹聚类, 找出 count>=2 的同构组——
 * 让下游把"这三个节点"实现为同一个组件的多个实例, 而非三份拷贝。
 * 附带节奏元数据(axis/gap): 列表实现的排布方向与间距可直接取用,
 * 无需从实例坐标反推。与 detectSharedComponents(跨 section 全局)互补。
 *
 * @param {Array} roots 蓝图树根数组
 * @param {object} [opts] minCount: 最小实例数(默认2); minArea: 最小面积(默认64, 滤微噪)
 * @returns {Array<{groupId, count, axis?, gap?, itemWidth, itemHeight, instances}>}
 */
export function detectSiblingComponentGroups(roots, opts = {}) {
  const minCount = opts.minCount ?? 2
  const minArea = opts.minArea ?? 64
  const groups = []
  let seq = 0
  const walk = (nodes) => {
    if (!Array.isArray(nodes) || nodes.length < minCount) {
      for (const n of nodes || []) walk(n?.children)
      return
    }
    const byFp = new Map()
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue
      const b = n.bounds || {}
      if ((b.width || 0) * (b.height || 0) < minArea) continue
      const fp = structureFingerprint(n, { sortChildren: true })
      if (!byFp.has(fp)) byFp.set(fp, [])
      byFp.get(fp).push(n)
    }
    const grouped = new Set()
    for (const members of byFp.values()) {
      if (members.length < minCount) continue
      seq++
      const g = {
        groupId: 'cg' + seq,
        count: members.length,
        itemWidth: round(members[0].bounds?.width || 0),
        itemHeight: round(members[0].bounds?.height || 0),
        ...measureGroupBounds(members),
        instances: members.map((m) => ({ id: m.id, name: m.name || '', x: round(m.bounds?.x || 0), y: round(m.bounds?.y || 0) })),
      }
      groups.push(g)
      // 组员子树不再重复成组(同构组的孩子也是同构的, 冗余)
      for (const m of members) grouped.add(m.id)
    }
    // 非组员子树继续下探(同层可有多个不同的组件组)
    for (const n of nodes) {
      if (grouped.has(n.id)) continue
      walk(n?.children)
    }
  }
  walk(Array.isArray(roots) ? roots : [roots])
  return groups
}

/**
 * 组员排布节奏(基于蓝图 bounds): 相邻实例主轴间距中位数。
 * 轴向取实例间位移跨度更大者; 重叠/不规则时 gap=null(交由 bounds 差值定位)。
 */
function measureGroupBounds(members) {
  if (!members || members.length < 2) return {}
  const xs = members.map((m) => m.bounds?.x ?? 0)
  const ys = members.map((m) => m.bounds?.y ?? 0)
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  const axis = spanX >= spanY ? 'row' : 'column'
  const sorted = [...members].sort((a, b) =>
    axis === 'row' ? (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0) : (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))
  const gaps = []
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1].bounds || {}
    const c = sorted[i].bounds || {}
    const g = axis === 'row'
      ? (c.x ?? 0) - ((p.x ?? 0) + (p.width ?? 0))
      : (c.y ?? 0) - ((p.y ?? 0) + (p.height ?? 0))
    if (isFinite(g)) gaps.push(round(g))
  }
  const allPositive = gaps.length > 0 && gaps.every((g) => g >= 0)
  return { axis, gap: allPositive ? medianOf(gaps) : null }
}

function medianOf(nums) {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : round((s[mid - 1] + s[mid]) / 2)
}
