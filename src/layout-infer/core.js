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
 * 纯函数,无副作用。Node / dsh bridge / MasterGo 插件共用。
 */

const TOL = 2 // 像素容差(整数坐标设计稿)
const ROTATION_KEY = 'rotation' // 节点带旋转 → 强制 absolute

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

function round1(v) {
  return Math.round(v * 10) / 10
}

/**
 * @param {object} opts
 * @param {{width:number,height:number}} opts.container
 * @param {Array<{id:string,x:number,y:number,width:number,height:number,rotation?:number}>} opts.children
 */
function inferLayout({ container, children }) {
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
    if (cx <= TOL) {
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
      }, cw, ch, stable, absolutes)
    }
    // 垂直居中: justifyContent center,水平位置由 padding 决定
    if (cy <= TOL) {
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
      }, cw, ch, stable, absolutes)
    }
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes] }
  }

  // 行/列判定: 支持「边缘对齐」「中心对齐」两种信号
  // 列布局的子元素可宽度不同(左/居中/右对齐);行布局的子元素可高度不同(顶/居中/底对齐)
  const topAligned = Math.max(...ys) - minY <= TOL
  const leftAligned = Math.max(...xs) - minX <= TOL
  const minBY = Math.min(...stable.map((k) => k.y + k.height))
  const minRX = Math.min(...stable.map((k) => k.x + k.width))
  const bottomAligned = maxBY - minBY <= TOL
  const rightAligned = maxRX - minRX <= TOL
  const centerXAligned = rangeX <= TOL
  const centerYAligned = rangeY <= TOL
  const spreadX = maxRX - minX
  const spreadY = maxBY - minY
  const rowSig = (topAligned || centerYAligned || bottomAligned) && spreadX > TOL
  const colSig = (leftAligned || centerXAligned || rightAligned) && spreadY > TOL

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
    const grid = inferGrid(stable, TOL)
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
  let alignItems = inferCrossAlign(stable, isRow, TOL)

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
  const mainSizing = Math.abs(mainExtent - mainContainer) <= TOL ? 'fixed' : 'auto'
  const crossSizing = Math.abs(crossExtent - crossContainer) <= TOL ? 'fixed' : 'auto'

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
  if (maxDelta > 2) {
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes] }
  }
  return result
}

/** 视觉保真验证: 模拟反写后的子元素位置,偏差超阈值 → 降级 absolute(视觉不变优先) */
function maybeDowngrade(result, cw, ch, stable, absolutes) {
  const sim = simulateFlex({ width: cw, height: ch }, result, stable)
  let maxDelta = 0
  for (let i = 0; i < sim.length && i < stable.length; i++) {
    const k = stable[i]
    const s = sim[i]
    if (!s) continue
    const d = Math.max(Math.abs(s.x - k.x), Math.abs(s.y - k.y))
    if (d > maxDelta) maxDelta = d
  }
  if (maxDelta > 2) {
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

export { inferLayout, mode, round1, simulateFlex, clusterByAxis }
if (typeof globalThis !== 'undefined') globalThis.layoutInfer = { inferLayout, mode, round1 }