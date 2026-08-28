'use strict'

/**
 * layout-infer: 从绝对坐标反推 flex 布局语义(布局反推内核)
 *
 * 输入: 一组兄弟节点 + 容器尺寸(坐标全部为相对父容器的局部坐标)
 * 输出: { flexDirection, gap, padding, alignItems, mainSizing, crossSizing,
 *         position, confidence, absolutes }
 *
 * 与官方 DSL 的 flexContainerInfo 字段对齐:
 *   { flexDirection, alignItems, mainSizing, crossSizing, gap, padding }
 *
 * 纯函数,无副作用。位于 @3kaiu/dsh-plugin-kit,供 dsh-layout-infer 等
 * 插件及 MasterGo 等外部工具通过 ESM import 复用
 * (不再污染 globalThis——宿主进程全局对象不属于插件)。
 *
 * ⚠️ 分叉声明(doc19 §2.2 批2, 2026-08-29): 本副本【冻结】—— v2 正本在
 * packages/ui-restore/src/layout-core.ts(功能超集: inferGridPattern/
 * inferStaggeredDeck/system-chrome/CONTAINER_ABSORB_RATIO 等), 本副本
 * 服务 layout-infer/ura。行为修改先评估正本是否同步; 批3 双向合并归一。
 */

import {
  GRADIENT_RE,
  round1,
  isBackgroundRect as isBackgroundRectShared,
  isContainerCandidate as isContainerCandidateShared,
  clusterBandsAdaptive as clusterBandsAdaptiveShared,
  clusterCols as clusterColsShared,
  bandBBox as bandBBoxShared,
  bandSize as bandSizeShared,
  bandMinX as bandMinXShared,
  bandMinY as bandMinYShared,
  colBBox as colBBoxShared,
  colSize as colSizeShared,
} from './cluster.ts'

export const TOL = 2 // 像素容差(整数坐标设计稿)
const ROTATION_KEY = 'rotation' // 节点带旋转 → 强制 absolute

// 兼容导出：原地保留常量与函数引用，便于外部按旧路径导入
const GRADIENT_RE_ALIAS = GRADIENT_RE
const isBackgroundRect = isBackgroundRectShared
const isContainerCandidate = isContainerCandidateShared
const clusterBandsAdaptive = clusterBandsAdaptiveShared
const clusterCols = clusterColsShared
const bandBBox = bandBBoxShared
const bandSize = bandSizeShared
const bandMinX = bandMinXShared
const bandMinY = bandMinYShared
const colBBox = colBBoxShared
const colSize = colSizeShared

/** 众数: 出现次数最多的值;无唯一众数返回 null
 *
 *  语义约定:
 *  - 空数组 → null
 *  - 单元素 → 该元素本身(平凡众数,调用方依赖此行为输出唯一 gap)
 *  - 多元素 → 唯一最大值且出现次数 >= 2 才返回;平票(如 [10,20] 或
 *    [10,10,20,20])或无重复(如 [10,20,30])一律返回 null,
 *    避免把「第一个碰到的值」误当众数。
 */
function mode(values) {
  if (values.length === 0) return null
  if (values.length === 1) return values[0]
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  let best = null
  let bestCount = 0
  let unique = true
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
      unique = true
    } else if (c === bestCount) {
      unique = false
    }
  }
  return bestCount >= 2 && unique ? best : null
}

/**
 * @param {object} opts
 * @param {{width:number,height:number}} opts.container
 * @param {Array<{id:string,x:number,y:number,width:number,height:number,rotation?:number}>} opts.children
 * @param {number} [opts.tolerance] 像素容差，默认 TOL=2；DOM 严格模式可传 1
 * @param {Array<string>} [opts.absolutesWhitelist] 参考本身即 absolute 的白名单 id，不计入违规
 */
function inferLayout({ container, children, tolerance, absolutesWhitelist }) {
  const TOL_LOCAL = tolerance != null ? tolerance : TOL
  const cw = container.width
  const ch = container.height
  const kids = children || []

  if (kids.length === 0) {
    return { position: 'absolute', confidence: 0.4, absolutes: [] }
  }

  // 旋转节点永远不参与 flex 推断(贴纸/装饰)
  const rotated = kids.filter((k) => Math.abs(k.rotation || 0) > 0.5)
  const stable = kids.filter((k) => Math.abs(k.rotation || 0) <= 0.5)
  const absolutes = rotated.map((k) => k.id)

  if (stable.length === 0) {
    return { position: 'absolute', confidence: 0.5, absolutes: [...absolutes] }
  }

  const centersX = stable.map((k) => k.x + k.width / 2)
  const centersY = stable.map((k) => k.y + k.height / 2)
  const rangeX = Math.max(...centersX) - Math.min(...centersX)
  const rangeY = Math.max(...centersY) - Math.min(...centersY)
  const xs = stable.map((k) => k.x)
  const ys = stable.map((k) => k.y)
  const maxRX = Math.max(...stable.map((k) => k.x + k.width))
  const maxBY = Math.max(...stable.map((k) => k.y + k.height))
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)

  // 单子节点: 任一轴居中 → flex(方向默认 column),否则 absolute
  if (stable.length === 1) {
    const k = stable[0]
    const pL = round1(k.x)
    const pT = round1(k.y)
    const pR = round1(cw - (k.x + k.width))
    const pB = round1(ch - (k.y + k.height))
    const hasHPad = pL > 0.01 || pR > 0.01
    const hasVPad = pT > 0.01 || pB > 0.01
    const cx = Math.abs(k.x + k.width / 2 - cw / 2)
    const cy = Math.abs(k.y + k.height / 2 - ch / 2)

    // 子元素溢出容器(flex 无法表达负 padding) → 放弃反写
    if (pL < -0.5 || pT < -0.5 || pR < -0.5 || pB < -0.5) {
      return { position: 'absolute', confidence: 0.3, absolutes: [...absolutes] }
    }

    // 水平居中: alignItems center,只保留垂直方向的显式 padding
    if (cx <= TOL_LOCAL) {
      return maybeDowngrade({
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: hasVPad ? 'flex-start' : 'center',
        gap: null,
        padding: hasVPad ? [pT, 0, pB, 0] : null,
        mainSizing: 'auto',
        crossSizing: 'auto',
        position: 'flex',
        confidence: 0.75,
        absolutes,
      }, cw, ch, stable, absolutes, TOL_LOCAL)
    }
    // 垂直居中: justifyContent center,水平位置由 padding 决定
    if (cy <= TOL_LOCAL) {
      return maybeDowngrade({
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        gap: null,
        padding: hasHPad ? [0, pR, 0, pL] : null,
        mainSizing: 'auto',
        crossSizing: 'auto',
        position: 'flex',
        confidence: 0.7,
        absolutes,
      }, cw, ch, stable, absolutes, TOL_LOCAL)
    }
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes] }
  }

  // 行/列判定: 支持「边缘对齐」「中心对齐」两种信号
  // 列布局的子元素可宽度不同(左/居中/右对齐);行布局的子元素可高度不同(顶/居中/底对齐)
  const topAligned = Math.max(...ys) - minY <= TOL_LOCAL
  const leftAligned = Math.max(...xs) - minX <= TOL_LOCAL
  const minBY = Math.min(...stable.map((k) => k.y + k.height))
  const minRX = Math.min(...stable.map((k) => k.x + k.width))
  const bottomAligned = maxBY - minBY <= TOL_LOCAL
  const rightAligned = maxRX - minRX <= TOL_LOCAL
  const centerXAligned = rangeX <= TOL_LOCAL
  const centerYAligned = rangeY <= TOL_LOCAL
  const spreadX = maxRX - minX
  const spreadY = maxBY - minY
  const rowSig = (topAligned || centerYAligned || bottomAligned) && spreadX > TOL_LOCAL
  const colSig = (leftAligned || centerXAligned || rightAligned) && spreadY > TOL_LOCAL

  let isRow = false
  let isColumn = false
  if (rowSig && !colSig) isRow = true
  else if (colSig && !rowSig) isColumn = true
  else if (rowSig && colSig) {
    if (spreadX >= spreadY) isRow = true
    else isColumn = true
  }

  if (!isRow && !isColumn) {
    // 行列都不成立 → 尝试网格(wrap)
    const grid = inferGrid(stable, TOL_LOCAL)
    if (grid) {
      return { ...grid, position: 'flex', confidence: 0.8, absolutes }
    }
    // 混合布局: 返回 absolute,把每个子单独标记
    return { position: 'absolute', confidence: 0.3, absolutes: [...absolutes, ...stable.map((k) => k.id)] }
  }

  const main = isRow ? 'row' : 'column'
  // 主轴排序
  const sorted = [...stable].sort((a, b) => (main === 'row' ? a.x - b.x : a.y - b.y))
  const gaps = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const gap = main === 'row' ? cur.x - (prev.x + prev.width) : cur.y - (prev.y + prev.height)
    if (gap >= 0) gaps.push(round1(gap))
  }
  let gap = mode(gaps)
  let justifyContent = null

  // 主轴对齐: 起始边对齐 = flex-start(默认 null);结束边对齐 = flex-end;
  // 中心对齐 = center。三者互斥(同时成立意味着元素重合,已被行列信号排除)。
  const mainStartAligned = main === 'row' ? leftAligned : topAligned
  const mainCenterAligned = main === 'row' ? centerXAligned : centerYAligned
  const mainEndAligned = main === 'row' ? rightAligned : bottomAligned
  if (mainEndAligned && !mainStartAligned) justifyContent = 'flex-end'
  else if (mainCenterAligned && !mainStartAligned) justifyContent = 'center'

  // space-between 检测: 主轴方向存在一个明显大分隔(远超其他间隙) → 两端分簇;
  // 仅在主轴无对齐信号时判定(结束边/中心对齐时主轴位置已确定,不适用)
  if (justifyContent === null && sorted.length >= 3 && gaps.length >= 2) {
    const maxG = Math.max(...gaps)
    const others = gaps.filter((g) => g < maxG - 0.01)
    const secondG = others.length ? Math.max(...others) : 0
    if (others.length >= 1 && maxG > secondG * 2.5) {
      const splitIdx = gaps.indexOf(maxG) // 分隔在 sorted[splitIdx] 与 sorted[splitIdx+1] 之间
      if (splitIdx >= 0 && splitIdx < sorted.length - 1) {
        const leftCluster = sorted.slice(0, splitIdx + 1)
        const rightCluster = sorted.slice(splitIdx + 1)
        if (leftCluster.length >= 1 && rightCluster.length >= 1) {
          const cGap = others.length ? mode(others) : null
          if (cGap !== null && cGap >= 0) {
            justifyContent = 'space-between'
            gap = cGap
          }
        }
      }
    }
  }
  const hasUniformGap = gap !== null && gaps.filter((g) => Math.abs(g - gap) <= 0.6).length >= gaps.length - 1

  // alignItems: 交叉轴对齐
  let alignItems = inferCrossAlign(stable, isRow, TOL_LOCAL)

  // padding: 子元素相对容器边缘
  const padLeft = round1(minX)
  const padTop = round1(minY)
  const padRight = round1(cw - maxRX)
  const padBottom = round1(ch - maxBY)
  const padding = [padTop, padRight, padBottom, padLeft]
  // 负 padding = 子元素溢出容器(flex 无法表达),放弃反写保证视觉不变
  if (padding.some((p) => p < -0.5)) {
    return { position: 'absolute', confidence: 0.3, absolutes: [...absolutes] }
  }

  // sizing: 容器主轴/交叉轴是否被内容撑起
  const mainExtent = main === 'row' ? maxRX : maxBY
  const crossExtent = main === 'row' ? maxBY : maxRX
  const mainContainer = main === 'row' ? cw : ch
  const crossContainer = main === 'row' ? ch : cw
  const mainSizing = Math.abs(mainExtent - mainContainer) <= TOL_LOCAL ? 'fixed' : 'auto'
  const crossSizing = Math.abs(crossExtent - crossContainer) <= TOL_LOCAL ? 'fixed' : 'auto'

  // 置信度: 主轴对齐一致性 + gap 均匀性
  let confidence = 0.75
  if (hasUniformGap) confidence += 0.1
  if (alignItems === 'center') confidence += 0.05
  if (Math.abs(padLeft - padRight) > 0.01 && Math.abs(padTop - padBottom) > 0.01) confidence -= 0.1

  const result = {
    flexDirection: main,
    alignItems,
    justifyContent,
    gap: hasUniformGap ? gap : null,
    padding,
    mainSizing,
    crossSizing,
    position: 'flex',
    confidence: round1(Math.min(confidence, 1)),
    absolutes,
  }

  // 视觉保真验证: 模拟反写后的子元素位置,偏差超阈值 → 降级 absolute(视觉不变优先)
  const sim = simulateFlex({ width: cw, height: ch }, result, stable)
  let maxDelta = 0
  for (let i = 0; i < sim.length && i < stable.length; i++) {
    const k = stable[i]
    const s = sim[i]
    if (!s) continue
    const d = Math.max(Math.abs(s.x - k.x), Math.abs(s.y - k.y))
    if (d > maxDelta) maxDelta = d
  }
  if (maxDelta > TOL_LOCAL) {
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes] }
  }
  return result
}

/** 视觉保真验证: 模拟反写后的子元素位置,偏差超阈值 → 降级 absolute(视觉不变优先) */
function maybeDowngrade(result, cw, ch, stable, absolutes, tolerance = TOL) {
  const sim = simulateFlex({ width: cw, height: ch }, result, stable)
  let maxDelta = 0
  for (let i = 0; i < sim.length && i < stable.length; i++) {
    const k = stable[i]
    const s = sim[i]
    if (!s) continue
    const d = Math.max(Math.abs(s.x - k.x), Math.abs(s.y - k.y))
    if (d > maxDelta) maxDelta = d
  }
  if (maxDelta > tolerance) {
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes] }
  }
  return result
}

/** 模拟 flex 反写后的子元素位置(CSS flex 布局算法)
 *
 *  与 CSS 对齐:主轴/交叉轴的偏移都相对 content box 计算
 *  (content box = 容器尺寸 − 两侧 padding),而不是相对 border box。
 */
function simulateFlex(container, inferred, kids) {
  const dir = inferred.flexDirection === 'row' ? 'row' : 'column'
  const pad = inferred.padding || [0, 0, 0, 0]
  const gap = inferred.gap || 0
  const mainSize = dir === 'row' ? container.width : container.height
  const crossSize = dir === 'row' ? container.height : container.width
  const mainDim = dir === 'row' ? 'width' : 'height'
  const crossDim = dir === 'row' ? 'height' : 'width'
  const padMainStart = dir === 'row' ? pad[3] : pad[0]
  const padMainEnd = dir === 'row' ? pad[1] : pad[2]
  const padCrossStart = dir === 'row' ? pad[0] : pad[3]
  const padCrossEnd = dir === 'row' ? pad[2] : pad[1]
  const mainContent = mainSize - padMainStart - padMainEnd
  const crossContent = crossSize - padCrossStart - padCrossEnd
  const sorted = [...kids].sort((a, b) => (dir === 'row' ? a.x - b.x : a.y - b.y))

  if (inferred.justifyContent === 'space-between') {
    const totalMain = sorted.reduce((s, k) => s + (k[mainDim] || 0), 0)
    const totalGap = mainContent - totalMain
    const slot = totalGap / Math.max(1, sorted.length - 1)
    return sorted.map((k, i) => {
      const mainPos = padMainStart + sorted.slice(0, i).reduce((s, kk) => s + (kk[mainDim] || 0), 0) + slot * i
      return placeIn(dir, k, mainPos, crossContent, padCrossStart, inferred)
    })
  }

  const content = sorted.reduce((s, k) => s + (k[mainDim] || 0), 0) + gap * (sorted.length - 1)
  let offset = padMainStart
  if (inferred.justifyContent === 'center') offset = padMainStart + (mainContent - content) / 2
  const res = []
  let cursor = offset
  for (const k of sorted) {
    res.push(placeIn(dir, k, cursor, crossContent, padCrossStart, inferred))
    cursor += (k[mainDim] || 0) + gap
  }
  return res
}

/** 单个子元素的交叉轴定位(CSS 语义: 相对 content box) */
function placeIn(dir, k, mainPos, crossContent, padCrossStart, inferred) {
  const crossDim = dir === 'row' ? 'height' : 'width'
  const size = k[crossDim] || 0
  let crossPos = padCrossStart
  if (inferred.alignItems === 'center') crossPos = padCrossStart + (crossContent - size) / 2
  else if (inferred.alignItems === 'end' || inferred.alignItems === 'flex-end')
    crossPos = padCrossStart + (crossContent - size)
  if (dir === 'row') return { x: mainPos, y: crossPos }
  return { x: crossPos, y: mainPos }
}

/** 交叉轴对齐推断
 *
 *  规则(按优先级):
 *  1. 所有子元素中心点一致 → center
 *  2. 所有起始边一致(top/left,高度或宽度可以不同)→ start
 *  3. 所有结束边一致(bottom/right)→ end
 *  4. 无法确定 → 保守 start(绝不输出 stretch:
 *     子元素尺寸不齐 ≠ 拉伸,设计稿里显式尺寸差异是常态,
 *     误标 stretch 会诱导还原方写出错误布局)。
 */
function inferCrossAlign(stable, isRow, tol) {
  const crossStart = stable.map((k) => (isRow ? k.y : k.x))
  const crossSize = stable.map((k) => (isRow ? k.height : k.width))
  const crossEnd = crossStart.map((s, i) => s + crossSize[i])
  const crossCenter = crossStart.map((s, i) => s + crossSize[i] / 2)
  const spreadCenter = Math.max(...crossCenter) - Math.min(...crossCenter)
  if (spreadCenter <= tol) return 'center'
  if (Math.max(...crossStart) - Math.min(...crossStart) <= tol) return 'start'
  if (Math.max(...crossEnd) - Math.min(...crossEnd) <= tol) return 'end'
  return 'start'
}

/** 沿一个轴做容差聚类: 位置(或与前簇末端的间距)在 tol 内归入同一簇
 *
 *  替代 Math.round 分组 key 的方案:浮点坐标(如 99.6 / 100.2)不再
 *  因四舍五入被拆成两行或误并成一行;只要相邻元素间距 <= tol 即同簇。
 */
function clusterByAxis(items, posOf, sizeOf, tol) {
  const sorted = [...items].sort((a, b) => posOf(a) - posOf(b))
  const clusters = []
  for (const k of sorted) {
    const pos = posOf(k)
    const end = pos + sizeOf(k)
    const last = clusters[clusters.length - 1]
    if (last !== void 0 && pos - last.maxEnd <= tol) {
      last.items.push(k)
      last.maxEnd = Math.max(last.maxEnd, end)
    } else {
      clusters.push({ items: [k], maxEnd: end })
    }
  }
  return clusters
}

// =====================================================================
// 层级重建内核 (hierarchy reconstruction)
// ---------------------------------------------------------------------
// 输入: 画布尺寸 + 一组兄弟节点(绝对坐标)。这些节点可能来自:
//   - 拍平稿(无 flexContainerInfo, 全部根级兄弟) —— 需要恢复容器树
//   - 任意 DSL 的某一层
// 输出: 重建后的语义树: 每节点带 role(语义角色)、bbox、layout(inferLayout
//   语义, 与官方 flexContainerInfo 对齐)、children(嵌套容器)。
//
// 管线(从开源方案提炼, imgcook 的 Y 轴重叠分组 / Locofy 的分组递归 /
// Allen 区间代数 / Gestalt 预聚类):
//   0. 分类: 越界元素(off-canvas) / 背景装饰层(background) / 旋转贴纸(sticker)
//   1. 容器吸收: 视觉容器候选(FRAME/GROUP/INSTANCE, 大尺寸/有特征)吸收
//      bbox 完全包含的其他节点
//   2. 带状聚类: 剩余顶层节点按 y 聚类成带(全宽条独立成带; gap 断裂;
//      y 重叠合并)
//   3. 带内分组: 每带内按 x 聚类成列
//   4. 语义角色: status-bar / nav-bar / tab-bar / card / section / row ...
//   5. 递归: 每个容器 inferLayout 反推 flex 语义
// =====================================================================

const ROLES = {
  OFF_CANVAS: 'off-canvas',
  BACKGROUND: 'background',
  STICKER: 'sticker',
  STATUS_BAR: 'status-bar',
  NAV_BAR: 'nav-bar',
  TAB_BAR: 'tab-bar',
  CARD: 'card',
  SECTION: 'section',
  ROW: 'row',
  COLUMN: 'column',
  ITEM: 'item',
  UNKNOWN: 'unknown',
}

/** 归一化节点输入: 兼容 {x,y,width,height} / {layoutStyle:{relativeX,...}} */
function normRect(n) {
  const ls = n.layoutStyle || {}
  const x = n.x != null ? n.x : ls.relativeX != null ? ls.relativeX : 0
  const y = n.y != null ? n.y : ls.relativeY != null ? ls.relativeY : 0
  const width = n.width != null ? n.width : ls.width != null ? ls.width : 0
  const height = n.height != null ? n.height : ls.height != null ? ls.height : 0
  const rotation = n.rotation != null ? n.rotation : ls.rotate != null ? ls.rotate : 0
  return { x, y, width, height, rotation }
}



/** 带语义角色: 全宽条按位置(顶/底)区分, 否则按内容分布 */
function bandRoleOf(band, canvas) {
  const first = band.items[0]
  // 带内含贴底全宽背景条(高度≤110) → TabBar(即使背景条未触发全宽条独立带规则)
  const bottomBg = band.items.find((n) => n._width >= canvas.width * 0.9 && n._y + n._height >= canvas.height - 12 && n._height <= 110)
  if (bottomBg && band.items.length >= 3) return ROLES.TAB_BAR
  if (band.fullWidth) {
    if (first._y <= 30) return ROLES.STATUS_BAR
    if (first._y + first.height >= canvas.height - 10) return ROLES.TAB_BAR
    return ROLES.NAV_BAR
  }
  if (band.items.length === 1) {
    const n = band.items[0]
    if (n._fill || n._radius || n._shadow) return ROLES.CARD
    return ROLES.UNKNOWN
  }
  return ROLES.SECTION
}

/** icon+label 配对(TabBar 项): 每个小方形图标 + 其下方最近的文本 */
function pairIconLabels(icons, labels, tol = 40) {
  const pairs = []
  const usedLabels = new Set()
  for (const ic of icons) {
    let best = null
    let bestDist = Infinity
    for (const lb of labels) {
      if (usedLabels.has(lb.id)) continue
      const dx = Math.abs(lb._x + lb.width / 2 - (ic._x + ic.width / 2))
      const dy = lb._y - (ic._y + ic.height)
      if (dx <= tol && dy >= -4 && dy < bestDist) {
        best = lb
        bestDist = dy
      }
    }
    if (best) {
      usedLabels.add(best.id)
      pairs.push({ icon: ic, label: best })
    } else {
      pairs.push({ icon: ic, label: null })
    }
  }
  return pairs
}

/**
 * 层级重建主入口
 *
 * @param {object} opts
 * @param {{width:number,height:number}} opts.canvas 画布尺寸
 * @param {Array} opts.nodes 兄弟节点(绝对坐标或 layoutStyle)
 * @returns {{tree:Array, stats:object, warnings:Array}}
 */
function reconstructHierarchy({ canvas, nodes }) {
  const warnings = []
  const stats = { total: nodes.length, offCanvas: 0, background: 0, sticker: 0, container: 0, band: 0, row: 0, column: 0, item: 0, section: 0 }

  // ---- 0. 归一化 + 分类 ----
  const prepared = nodes.map((n, i) => {
    const r = normRect(n)
    const fill = typeof n._color === 'string' ? n._color : Array.isArray(n._color) ? String(n._color[0]) : ''
    return {
      ...n,
      _x: r.x,
      _y: r.y,
      _width: r.width,
      _height: r.height,
      _rotation: r.rotation,
      _fill: fill,
      _radius: n.borderRadius || n._radius || null,
      _shadow: n.effect || n._shadow || null,
      _idx: i,
    }
  })

  const offCanvas = prepared.filter((n) => n._x + n._width > canvas.width + 8 || n._x < -8 || n._y < -8 || n._y + n._height > canvas.height + 8)
  stats.offCanvas = offCanvas.length
  const onCanvas = prepared.filter((n) => !offCanvas.includes(n))

  const backgrounds = onCanvas.filter((n) => isBackgroundRect(n, canvas))
  stats.background = backgrounds.length
  let rest = onCanvas.filter((n) => !backgrounds.includes(n))

  // 注意: 旋转贴纸组不在此处提前移除 —— 它们可能被卡片吸收
  // (贴纸卡内含 parking/LOVE/milk tea 等旋转贴纸), 吸收后再把
  // 未被吸收的旋转节点标记为顶层 sticker。

  // ---- 1. 大容器分类: 吸收子节点的容器 / 有视觉特征的独立容器, 均不参与带状聚类 ----
  const absorbed = new Map() // containerId -> [childIds]
  const assigned = new Set() // 被吸收的子节点
  const absorbedContainers = new Set() // 吸收过子节点的容器(独立成块)
  const standaloneContainers = new Set() // 无子节点但有阴影/填充/圆角的容器(独立成块)
  const containers = rest.filter(isContainerCandidate).sort((a, b) => a._width * a._height - b._width * b._height)
  for (const c of containers) {
    if (assigned.has(c.id) || absorbedContainers.has(c.id) || standaloneContainers.has(c.id)) continue
    const kids = rest.filter((n) => {
      if (n === c || assigned.has(n.id) || absorbedContainers.has(n.id) || standaloneContainers.has(n.id)) return false
      // 旋转贴纸组(parking/LOVE 等)允许被卡片吸收: 用未旋转的轴对齐 bbox
      // 做包含判断, 吸收后角色标 sticker(见 buildLeaf 分支)
      const inside = n._x >= c._x - 2 && n._y >= c._y - 2 && n._x + n._width <= c._x + c._width + 2 && n._y + n._height <= c._y + c._height + 2
      if (!inside) return false
      return n._width * n._height < c._width * c._height * 0.9
    })
    if (kids.length > 0) {
      absorbed.set(c.id, kids.map((k) => k.id))
      for (const k of kids) assigned.add(k.id)
      absorbedContainers.add(c.id)
      stats.container++
    } else if (c._shadow || c._fill || c._radius) {
      standaloneContainers.add(c.id)
      stats.container++
    }
  }

  // 独立块(吸收容器 + 独立容器)转成容器节点
  const containerBlocks = []
  for (const c of rest.filter((n) => absorbedContainers.has(n.id) || standaloneContainers.has(n.id))) {
    const kids = (absorbed.get(c.id) || []).map((id) => prepared.find((x) => x.id === id)).filter(Boolean)
    containerBlocks.push({
      id: c.id,
      name: c.name || '',
      type: c.type,
      role: c._shadow ? ROLES.CARD : ROLES.SECTION,
      bbox: { x: round1(c._x), y: round1(c._y), width: round1(c._width), height: round1(c._height) },
      layout: kids.length > 0
        ? inferLayout({
            container: { width: c._width, height: c._height },
            children: kids.map((k) => ({ id: k.id, x: k._x - c._x, y: k._y - c._y, width: k._width, height: k._height, rotation: k._rotation })),
          })
        : null,
      children: kids.map((k) =>
        Math.abs(k._rotation || 0) > 0.5 ? { ...buildLeaf(k), role: ROLES.STICKER } : buildLeaf(k),
      ),
    })
  }

  // 剩余全部(容器 + 叶子)统一参与带状聚类; 被吸收的节点从顶层移除
  const floaters = rest.filter((n) => !assigned.has(n.id) && !absorbedContainers.has(n.id) && !standaloneContainers.has(n.id))

  // 未被吸收的旋转节点 → 顶层 sticker(参与带状聚类前剔除)
  const stickers = floaters.filter((n) => Math.abs(n._rotation || 0) > 0.5)
  stats.sticker = stickers.length
  const bandFloaters = floaters.filter((n) => !stickers.includes(n))

  // ---- 2. 带状聚类 + 带内分组 ----
  const bands = clusterBandsAdaptive(bandFloaters, canvas)
  stats.band = bands.length

  const children = []
  const pushNode = (n) => children.push(buildLeaf(n))
  for (const band of bands) {
    const role = bandRoleOf(band, canvas)
    // TabBar 特判: 全宽背景条 + icon/label 对
    if (role === ROLES.TAB_BAR) {
      const bg = band.items.filter((n) => n._width >= canvas.width * 0.9)
      const items = band.items.filter((n) => !bg.includes(n))
      const icons = items.filter((n) => n.type !== 'TEXT' && n._height <= 30 && n._height >= 14 && n._width <= 40)
      const labels = items.filter((n) => n.type === 'TEXT')
      const restItems = items.filter((n) => !icons.includes(n) && !labels.includes(n))
      const pairs = pairIconLabels(icons, labels)
      const tabItems = pairs.map((p) => ({
        id: 'synthetic:tab-item:' + p.icon.id,
        name: p.label ? p.label.name || p.icon.name : p.icon.name,
        type: 'GROUP',
        role: ROLES.ITEM,
        bbox: { x: round1(p.icon._x), y: round1(Math.min(p.icon._y, p.label ? p.label._y : p.icon._y)), width: round1(p.icon._width), height: round1(p.label ? p.label._y + p.label._height - p.icon._y : p.icon._height) },
        children: [
          buildLeaf(p.icon),
          ...(p.label ? [buildLeaf(p.label)] : []),
        ],
      }))
      const leftover = labels.filter((l) => !pairs.some((p) => p.label && p.label.id === l.id))
      const bgLeaf = bg.length > 0 ? { ...buildLeaf(bg[0]), role: ROLES.BACKGROUND } : null
      const bandKids = [...tabItems, ...restItems.map((n) => ({ id: n.id, x: n._x - bandMinX(band), y: n._y - bandMinY(band), width: n._width, height: n._height }))]
      children.push({
        id: 'synthetic:tab-bar:' + band.items[0].id,
        name: 'tab-bar',
        type: band.items[0].type,
        role,
        bbox: bandBBox(band),
        layout: inferLayout({ container: bandSize(band), children: bandKids }),
        children: [...(bgLeaf ? [bgLeaf] : []), ...tabItems, ...restItems.map(buildLeaf), ...leftover.map(buildLeaf)],
      })
      stats.item += tabItems.length
      continue
    }
    // 单节点带: 叶子直接输出; 容器(全宽条/卡片)保持独立容器
    if (band.items.length === 1) {
      const n = band.items[0]
      if (n.type === 'TEXT') {
        pushNode(n)
      } else {
        children.push(buildContainer(n, role))
      }
      continue
    }
    // 多节点带: 委托 inferLayout 判定方向(row/column/absolute)
    const relKids = band.items.map((n) => ({
      id: n.id,
      x: n._x - bandMinX(band),
      y: n._y - bandMinY(band),
      width: n._width,
      height: n._height,
      rotation: n._rotation,
    }))
    const layout = inferLayout({ container: bandSize(band), children: relKids })
    const groupRole =
      layout.position === 'flex' && layout.flexDirection === 'column'
        ? ROLES.COLUMN
        : layout.position === 'flex' && layout.flexDirection === 'row'
          ? ROLES.ROW
          : ROLES.SECTION
    stats[groupRole === ROLES.ROW ? 'row' : groupRole === ROLES.COLUMN ? 'column' : 'section']++
    children.push({
      id: 'synthetic:' + groupRole + ':' + band.items[0].id,
      name: groupRole === ROLES.ROW ? 'row-group' : groupRole === ROLES.COLUMN ? 'column-group' : 'section',
      type: 'GROUP',
      role: groupRole,
      bbox: bandBBox(band),
      layout,
      children: clusterCols(band.items).map((c) => {
        const sorted = [...c.items].sort((a, b) => a._y - b._y || a._x - b._x)
        if (sorted.length === 1) return buildLeaf(sorted[0])
        return {
          id: 'synthetic:column-group:' + sorted[0].id,
          name: 'column-group',
          type: 'GROUP',
          role: ROLES.COLUMN,
          bbox: colBBox(sorted),
          layout: inferLayout({
            container: colSize(sorted),
            children: sorted.map((n) => ({ id: n.id, x: n._x - bandMinX(band), y: n._y - bandMinY(band), width: n._width, height: n._height })),
          }),
          children: sorted.map(buildLeaf),
        }
      }),
    })
  }

  // ---- 最终树: 背景 + 独立块 + 带块按 y 排序 ----
  const backgroundLeaves = backgrounds.map((n) => ({ ...buildLeaf(n), role: ROLES.BACKGROUND }))
  const stickerLeaves = stickers.map((n) => ({ ...buildLeaf(n), role: ROLES.STICKER }))
  const offCanvasLeaves = offCanvas.map((n) => ({ ...buildLeaf(n), role: ROLES.OFF_CANVAS }))
  const allBlocks = [...backgroundLeaves, ...containerBlocks, ...children, ...stickerLeaves].sort((a, b) => a.bbox.y - b.bbox.y)
  const tree = [...allBlocks, ...offCanvasLeaves]

  return { tree, stats, warnings }
}

function buildLeaf(n) {
  return {
    id: n.id,
    name: n.name || '',
    type: n.type,
    role: ROLES.UNKNOWN,
    bbox: { x: round1(n._x), y: round1(n._y), width: round1(n._width), height: round1(n._height) },
    children: [],
  }
}

function buildContainer(n, role) {
  return {
    id: n.id,
    name: n.name || '',
    type: n.type,
    role: role || ROLES.CARD,
    bbox: { x: round1(n._x), y: round1(n._y), width: round1(n._width), height: round1(n._height) },
    layout: null,
    children: [],
  }
}

export { inferLayout, mode, simulateFlex, clusterByAxis, reconstructHierarchy, ROLES }

/** 网格推断: 规整行列矩阵 → flexWrap wrap */
function inferGrid(children, tol) {
  const rows = clusterByAxis(children, (k) => k.y, (k) => k.height, tol)
  const cols = clusterByAxis(children, (k) => k.x, (k) => k.width, tol)
  if (rows.length < 2 || cols.length < 2) return null
  // 所有行高一致 & 所有列宽一致
  const heights = rows.map((r) => Math.max(...r.items.map((k) => k.height)))
  const widths = cols.map((c) => Math.max(...c.items.map((k) => k.width)))
  if (Math.max(...heights) - Math.min(...heights) > tol) return null
  if (Math.max(...widths) - Math.min(...widths) > tol) return null
  // 每个 cell 单节点
  const expected = rows.length * cols.length
  if (children.length !== expected) return null
  return {
    flexDirection: 'row',
    alignItems: 'start',
    flexWrap: 'wrap',
    gap: null,
    padding: null,
    mainSizing: 'auto',
    crossSizing: 'auto',
  }
}
