// yoga-truth.ts - 布局真值引擎
// 用标准 flexbox 求解器(Yoga, WASM)对蓝图的 flex 推断求"真值":
// 把每个 row/column 容器的推断参数(direction/gap/padding/对齐)喂给 Yoga 重排,
// 逐子节点比对求解几何 vs 设计稿原始几何(bounds 差值), 输出量化偏差报告。
//
// 定位: 纯中立增强。不修改蓝图本身, 只提供可信度门禁 ——
// simulateFlex 是自写公式(启发式), Yoga 是业界标准实现(真值),
// 两者一致 => 推断可信; 不一致 => 该容器的 flex 指令不应被下游信任。

import Yoga, { FlexDirection, Justify, Align, Edge, Gutter, Direction, PositionType } from "yoga-layout";
import { round2 } from "./numeric.ts"

const JUSTIFY = {
  start: Justify.FlexStart,
  center: Justify.Center,
  end: Justify.FlexEnd,
  "space-between": Justify.SpaceBetween,
  "space-around": Justify.SpaceAround,
  "space-evenly": Justify.SpaceEvenly,
}
const ALIGN = {
  start: Align.FlexStart,
  center: Align.Center,
  end: Align.FlexEnd,
  stretch: Align.Stretch,
  baseline: Align.Baseline,
}

/**
 * 单容器真值求解: 用推断的 flex 参数重排设计尺寸固定的子节点,
 * 比对求解位置与设计位置(bounds 相对父容器差值)。
 */
function checkContainer(node, kids, tolerance) {
  const pb = node.bounds || {}
  const ly = node.layout || {}
  const rel = (cb) => ({
    x: round2((cb.x ?? 0) - (pb.x ?? 0)),
    y: round2((cb.y ?? 0) - (pb.y ?? 0)),
  })

  // 变间距/负间距无法用标准 gap 表达(蓝图语义为逐项偏移), 跳过求解
  if (Array.isArray(ly.gap)) {
    return { containerId: node.id, role: ly.role, skipped: true, reason: "gap-array", childCount: kids.length }
  }

  const root = Yoga.Node.create()
  root.setWidth(pb.width > 0 ? pb.width : undefined)
  root.setHeight(pb.height > 0 ? pb.height : undefined)
  root.setFlexDirection(ly.role === "row" ? FlexDirection.Row : FlexDirection.Column)
  root.setJustifyContent(JUSTIFY[ly.justifyContent] ?? Justify.FlexStart)
  root.setAlignItems(ALIGN[ly.alignItems] ?? Align.FlexStart)
  if (ly.gap > 0) root.setGap(ly.role === "row" ? Gutter.Column : Gutter.Row, ly.gap)
  const pad = Array.isArray(ly.padding) ? ly.padding : [0, 0, 0, 0]
  if (pad.some((v) => v > 0)) {
    // 蓝图 padding 约定: [top, right, bottom, left]
    root.setPadding(Edge.Top, pad[0] || 0)
    root.setPadding(Edge.Right, pad[1] || 0)
    root.setPadding(Edge.Bottom, pad[2] || 0)
    root.setPadding(Edge.Left, pad[3] || 0)
  }

  const entries = []
  for (const c of kids) {
    const cb = c.bounds || {}
    const n = Yoga.Node.create()
    n.setWidth(cb.width > 0 ? cb.width : undefined)
    n.setHeight(cb.height > 0 ? cb.height : undefined)
    const expected = rel(cb)
    if ((c.layout && c.layout.position === "absolute") || !cb.width || !cb.height) {
      // 绝对定位子项直接编码设计坐标, 无需信任 flex 推断
      n.setPositionType(PositionType.Absolute)
      n.setPosition(Edge.Left, expected.x)
      n.setPosition(Edge.Top, expected.y)
    }
    // 真值驱动的交叉轴残差校正(真值自愈第二级写入): 语义为"布局后交叉轴平移 px"。
    // start 对齐: 以 margin 等价表达, 可被本求解器验证;
    // center/end 对齐: margin 会干扰居中语义, 求解器跳过该项(下游以 translate 实现)。
    const crossOffset = c.layout && typeof c.layout.crossOffset === "number" ? c.layout.crossOffset : null
    let skipDelta = false
    if (crossOffset != null && crossOffset !== 0) {
      if ((ly.alignItems ?? "start") === "start") {
        n.setMargin(ly.role === "row" ? Edge.Top : Edge.Left, crossOffset)
      } else {
        skipDelta = true
      }
    }
    root.insertChild(n, entries.length)
    entries.push({ id: c.id, name: c.name || "", ynode: n, expected, skipDelta })
  }

  root.calculateLayout(undefined, undefined, Direction.LTR)

  let maxDelta = 0
  let offenderCount = 0
  let unverifiable = 0
  const offenders = []
  for (const e of entries) {
    if (e.ynode.getPositionType() === PositionType.Absolute) continue
    if (e.skipDelta) { unverifiable++; continue }
    const solved = { x: round2(e.ynode.getComputedLeft()), y: round2(e.ynode.getComputedTop()) }
    const dx = round2(Math.abs(solved.x - e.expected.x))
    const dy = round2(Math.abs(solved.y - e.expected.y))
    const delta = Math.max(dx, dy)
    if (delta > maxDelta) maxDelta = delta
    if (delta > tolerance) {
      offenderCount++
      offenders.push({ containerId: node.id, childId: e.id, childName: e.name, dx, dy, solved, expected: e.expected })
    }
  }
  root.freeRecursive()

  return { containerId: node.id, role: ly.role, skipped: false, childCount: entries.length, unverifiableCorrections: unverifiable, maxDelta: round2(maxDelta), offenders }
}

/**
 * 布局真值验证 (verifyLayoutTruth)
 * 遍历蓝图中全部 row/column 容器, 逐一做 Yoga 真值求解与设计几何比对。
 *
 * @param {object} blueprint generateCodeBlueprint 的输出({tree, floatings, ...})
 * @param {object} [opts] tolerance: 判定像素完美的绝对坐标容差(默认 0.04px)
 * @returns {{engine, containersChecked, containersSkipped, childrenChecked, childrenMatched,
 *            maxDelta, pixelPerfectRatio, worst: Array, verdict}}
 */
export function verifyLayoutTruth(blueprint, opts = {}) {
  const tolerance = opts.tolerance != null ? opts.tolerance : 0.04
  if (!blueprint) return null
  const results = []
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    const kids = Array.isArray(node.children) ? node.children : []
    const ly = node.layout || {}
    if ((ly.role === "row" || ly.role === "column") && kids.length > 0) {
      results.push(checkContainer(node, kids, tolerance))
    }
    for (const k of kids) walk(k)
  }
  for (const root of [...(blueprint.tree || []), ...(blueprint.floatings || [])]) walk(root)

  const checked = results.filter((r) => !r.skipped)
  const skipped = results.filter((r) => r.skipped)
  const childrenChecked = checked.reduce((s, r) => s + r.childCount, 0)
  const unverifiableCorrections = checked.reduce((s, r) => s + (r.unverifiableCorrections || 0), 0)
  const offenderTotal = checked.reduce((s, r) => s + r.offenders.length, 0)
  const maxDelta = round2(checked.reduce((m, r) => Math.max(m, r.maxDelta), 0))
  const worst = checked
    .flatMap((r) => r.offenders.map((o) => ({ ...o, delta: Math.max(o.dx, o.dy) })))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 8)

  return {
    engine: "yoga",
    containersChecked: checked.length,
    containersSkipped: skipped.length,
    childrenChecked,
    childrenMatched: childrenChecked - offenderTotal,
    unverifiableCorrections,
    maxDelta,
    pixelPerfectRatio: childrenChecked > 0 ? round2((childrenChecked - offenderTotal) / childrenChecked) : 1,
    worst,
    verdict: maxDelta <= tolerance ? "PASS_TRUTH_PERFECT" : `FAIL_TRUTH_MAX_DELTA_${maxDelta}`,
  }
}
