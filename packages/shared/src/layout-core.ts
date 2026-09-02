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
 * 纯函数,无副作用。自 @3kaiu/dsh-plugin-kit/layout-core 分叉后独立演进
 * (不再污染 globalThis——宿主进程全局对象不属于插件)。
 *
 * ⚠️ 正本归一(doc19 §2.2 批3, 2026-08-29): v2 引擎已整体并入 kit 作为唯一实现,
 * 并吸收 kit 基底的 tolerance/absolutesWhitelist 参数(默认行为与 v2 一致);
 * kit 基底的 inferGrid wrap 回退被 v2 裁决移除(伪 wrap 破坏几何守恒)。
 * 本文件是【纯引擎切片】: 只含几何推断与样式解析, 不依赖任何运行时增强
 * (opentype/yoga 留在 ui-restore 的蓝图构建层, 避免所有 bundle kit 的插件被拖入重依赖)。
 */

import { isBackgroundRect, isContainerCandidate, clusterBandsAdaptive, clusterCols, bandBBox, bandSize, bandMinX, bandMinY, colBBox, colSize, round1 } from './cluster.ts'

export const TOL = 2 // 像素容差(整数坐标设计稿)
const ROTATION_KEY = 'rotation' // 节点带旋转 → 强制 absolute

/** 机器命名检测: 设计工具自动生成的无语义名(编组 45/矩形 6509/容器 17/蒙版组 2/Frame 328…) */
const MACHINE_NAME_RE = /^(编组|组|组合|矩形|矩形组|椭圆|直线|路径|蒙版|蒙版组|遮罩|容器|组件|框架|切片|帧|图层|形状|画板|页面|frame|group|rect(?:angle)?|oval|line|path|vector|layer|mask|slice|shape|ellipse|instance|component|section|artboard|canvas)[\s_#\-]*\d*(\s*copy\d*)*$/i

function firstDescendantText(node, depth = 0) {
  if (!node || depth > 3) return null
  // text 双形态兼容: 字符串直读; runs 数组拼接(MasterGo 常态)
  const t = typeof node.text === 'string' ? node.text
    : Array.isArray(node.text) ? node.text.map((r) => (r && r.text) || '').join('')
    : null
  if (t && t.trim()) return t.trim()
  for (const c of Array.isArray(node.children) ? node.children : []) {
    const t2 = firstDescendantText(c, depth + 1)
    if (t2) return t2
  }
  return null
}

/**
 * 语义命名净化 (semanticNodeName): 名字只服务 LLM 理解, 不参与几何/样式/指纹。
 * 设计者命名原样保留; 机器名/空名合成为可读标签:
 * 首个后代文本 > 图标名(svgName) > 类型序号 —— 消除产物名字里 ~40% 的纯噪声。
 */
function semanticNodeName(node, rawNode, seq) {
  const raw = String(rawNode?.name ?? node?.name ?? '').trim()
  if (raw && !MACHINE_NAME_RE.test(raw)) return raw
  const t = firstDescendantText(node)
  if (t) return `${node.type || 'NODE'}:${t.slice(0, 16)}`
  const icon = rawNode?.svgName || node?.svgName
  if (icon) return `${node.type || 'NODE'}:${String(icon).slice(0, 24)}`
  // 机器名/空名且无可派生语义: 统一为 类型#序号(短、一致、无伪语义)
  return `${node.type || 'NODE'}#${seq}`
}

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
 */
function inferLayout({ container, children, tolerance = null, absolutesWhitelist = null }) {
  const TOL_LOCAL = tolerance != null ? tolerance : TOL
  const cw = container.width
  const ch = container.height
  const kids = children || []

  if (kids.length === 0) {
    return { position: 'absolute', confidence: 0.4, absolutes: [], reason: '无子节点' }
  }

  // 旋转节点永远不参与 flex 推断(贴纸/装饰)
  const rotated = kids.filter((k) => Math.abs(k.rotation || 0) > 0.5)
  const stable = kids.filter((k) => Math.abs(k.rotation || 0) <= 0.5)
  const absolutes = rotated.map((k) => k.id)

  if (stable.length === 0) {
    return { position: 'absolute', confidence: 0.5, absolutes: [...absolutes], reason: '全部子节点带旋转' }
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
      return { position: 'absolute', confidence: 0.3, absolutes: [...absolutes], reason: '子元素溢出容器' }
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
        reason: '单子节点水平居中',
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
        reason: '单子节点垂直居中',
      }, cw, ch, stable, absolutes, TOL_LOCAL)
    }
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes], reason: '单子节点无对齐信号' }
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
    // 行列都不成立 → absolute(stack 语义), 几何由 bounds 差值守恒。
    // 注意(批3 归一裁决): kit 基底曾有 inferGrid wrap 回退, v2 正本刻意移除 ——
    // 抖动网格被伪判 wrap 后几何守恒失败("无伪 wrap"), 以 v2 语义为准。
    return { position: 'absolute', confidence: 0.3, absolutes: [...absolutes, ...stable.map((k) => k.id)], reason: '无行列对齐信号' }
  }

  const main = isRow ? 'row' : 'column'
  // 主轴排序
  const sorted = [...stable].sort((a, b) => (main === 'row' ? a.x - b.x : a.y - b.y))
  // gapsAll: 相邻对(按主轴排序)的全部间距,含负值(重叠);spacing 数组的语义来源
  // gaps(仅≥0)保留给 mode/space-between 判定
  const gapsAll = []
  const gaps = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const gap = main === 'row' ? cur.x - (prev.x + prev.width) : cur.y - (prev.y + prev.height)
    gapsAll.push(round1(gap))
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
  const hasUniformGap = gap !== null && !gapsAll.some((g) => g < -0.01) && gaps.filter((g) => Math.abs(g - gap) <= 0.6).length >= gaps.length - 1

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
    return { position: 'absolute', confidence: 0.3, absolutes: [...absolutes], reason: '子元素溢出容器(负边距)' }
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

  // 判定依据摘要: 主轴信号来源(+等间距), 随蓝图输出供 LLM 评估推理可信度
  const mainSig = main === 'row'
    ? (topAligned ? '顶对齐' : centerYAligned ? '中心对齐' : '底对齐')
    : (leftAligned ? '左对齐' : centerXAligned ? '中心对齐' : '右对齐')
  const reason = `${main}(${mainSig})${hasUniformGap ? '+等间距' : ''}`

  const result = {
    flexDirection: main,
    alignItems,
    justifyContent,
    gap: hasUniformGap ? gap : null,
    // 不等间距/负间距时携带 per-pair 间距数组(相邻对,按主轴排序),供下游 spacing 渲染
    spacing: hasUniformGap || justifyContent === 'space-between' ? undefined : gapsAll.slice(),
    padding,
    mainSizing,
    crossSizing,
    position: 'flex',
    confidence: round1(Math.min(confidence, 1)),
    absolutes,
    reason,
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
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes], reason: 'flex模拟偏差>2px,降级保真' }
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
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes], reason: 'flex模拟偏差>2px,降级保真' }
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
  // 不等间距: spacing 数组按相邻对(主轴排序)给出 per-pair gap;否则用统一 gap
  const spacing = Array.isArray(inferred.spacing) ? inferred.spacing : null
  const gap = inferred.gap || 0
  const gapAt = (i) => (spacing ? (i > 0 && i - 1 < spacing.length ? spacing[i - 1] : 0) : gap)
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

  let content = sorted.reduce((s, k) => s + (k[mainDim] || 0), 0)
  for (let i = 1; i < sorted.length; i++) content += gapAt(i)
  let offset = padMainStart
  if (inferred.justifyContent === 'center') offset = padMainStart + (mainContent - content) / 2
  const res = []
  let cursor = offset
  for (let i = 0; i < sorted.length; i++) {
    const k = sorted[i]
    res.push(placeIn(dir, k, cursor, crossContent, padCrossStart, inferred))
    cursor += (k[mainDim] || 0) + gapAt(i + 1)
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

/** 多列网格规律推导: 识别等宽/等高、均匀水平间隙的 N 列排列 (通用几何推导) */
function inferGridPattern(children, tol = TOL) {
  if (!children || children.length < 2) return null;
  const rows = clusterByAxis(children, (k) => k.y, (k) => k.height, tol);
  if (rows.length === 0) return null;
  const firstRow = rows[0].items;
  if (firstRow.length >= 2) {
    const widths = firstRow.map((k) => k.width);
    const heights = firstRow.map((k) => k.height);
    const isUniformW = Math.max(...widths) - Math.min(...widths) <= tol;
    const isUniformH = Math.max(...heights) - Math.min(...heights) <= tol;
    if (isUniformW && isUniformH) {
      const sorted = [...firstRow].sort((a, b) => a.x - b.x);
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push(round1(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width)));
      }
      const colGap = mode(gaps) ?? gaps[0] ?? 0;
      return {
        isGrid: true,
        columns: firstRow.length,
        columnGap: colGap,
        itemWidth: round1(widths[0]),
        itemHeight: round1(heights[0]),
        rowsCount: rows.length,
      };
    }
  }
  return null;
}

/** 错位/扇形层叠卡片推导: 识别局部重叠的一组尺寸相近卡片 (通用几何推导) */
function inferStaggeredDeck(children, tol = TOL) {
  if (!children || children.length < 2) return null;
  const sorted = [...children].sort((a, b) => a.x - b.x);
  const widths = sorted.map((k) => k.width);
  const heights = sorted.map((k) => k.height);
  const maxW = Math.max(...widths);
  const minW = Math.min(...widths);
  const maxH = Math.max(...heights);
  const minH = Math.min(...heights);
  // 容差: 尺寸差异在 25% 以内即视为同级错位卡片
  const isSimilarW = (maxW - minW) / maxW <= 0.25 || (maxW - minW) <= 24;
  const isSimilarH = (maxH - minH) / maxH <= 0.25 || (maxH - minH) <= 24;
  if (!isSimilarW || !isSimilarH) return null;
  let isContinuous = true;
  const offsets = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur.x - (prev.x + prev.width);
    if (gap < -prev.width * 0.95 || gap > 24) {
      isContinuous = false;
      break;
    }
    offsets.push(round1(cur.x - prev.x));
  }
  if (isContinuous && offsets.length > 0) {
    return {
      isDeck: true,
      count: sorted.length,
      stepOffset: mode(offsets) ?? offsets[0],
      itemWidth: round1(widths[0]),
      itemHeight: round1(heights[0]),
    };
  }
  return null;
}

/** 悬浮胶囊/浮层判定: 水平居中 + 距底部有间隙 + 紧凑尺寸 (通用几何推导) */
function isFloatingCapsule(n, canvas) {
  if (!n || !canvas) return false;
  const w = n._width ?? n.width ?? 0;
  const h = n._height ?? n.height ?? 0;
  const x = n._x ?? n.x ?? 0;
  const y = n._y ?? n.y ?? 0;
  if (w < 80 || w > canvas.width * 0.85) return false;
  if (h > 65 || h < 24) return false;
  const centerX = x + w / 2;
  if (Math.abs(centerX - canvas.width / 2) > 24) return false;
  const bottomClearance = canvas.height - (y + h);
  if (bottomClearance < 10 || bottomClearance > 220) return false;
  return true;
}

/** 视口断点自适应推导: 画布规格 -> 设备断点与基准画板尺寸 (通用几何推导) */
function inferViewportMetadata(canvas) {
  const w = canvas?.width || 375;
  const h = canvas?.height || 812;
  const isCompact = w < 600;
  const isMedium = w >= 600 && w <= 1024;
  const isExpanded = w > 1024;
  const deviceType = isCompact ? 'phone' : isMedium ? 'tablet' : 'desktop';
  const standardDesignWidth = isCompact ? 375 : isMedium ? 820 : 1440;
  return {
    canvas: { width: w, height: h },
    deviceType,
    standardDesignWidth,
    isCompact,
    isMedium,
    isExpanded,
    aspectRatio: round1(w / h),
  };
}

/**
 * 通用 1:1 视觉样式属性直读与提取 (extractExactStyles)
 * 严格按照 MasterGo DSL 原始数据映射，禁止任何主观臆测与偏离
 */
function extractExactStyles(node, styles: Record<string, any> = {}) {
  if (!node) return {};
  const out: Record<string, any> = {};

  // 1. 尺寸与位置 (绝对/相对精度保留两位)
  const ls = node.layoutStyle || {};
  if (ls.width != null) out.width = round1(ls.width);
  if (ls.height != null) out.height = round1(ls.height);
  if (ls.relativeX != null) out.x = round1(ls.relativeX);
  if (ls.relativeY != null) out.y = round1(ls.relativeY);
  if (ls.rotate != null && Math.abs(ls.rotate) > 0.01) out.rotation = round1(ls.rotate);

  // 2. 圆角提取 (支持单值或四角独立值)
  if (node.borderRadius != null) {
    if (Array.isArray(node.borderRadius)) {
      out.borderRadius = node.borderRadius.map(round1);
    } else {
      out.borderRadius = round1(node.borderRadius);
    }
  } else if (node.rectangleCornerRadii != null) {
    out.borderRadius = node.rectangleCornerRadii.map(round1);
  }

  // 3. 不透明度
  if (node.opacity != null && node.opacity < 1) {
    out.opacity = round1(node.opacity);
  }

  // 4. 阴影与滤镜 (Effects: DROP_SHADOW, INNER_SHADOW, BACKGROUND_BLUR)
  const rawEffects = node.effects || node.styles?.effects || [];
  const effects = [];
  for (const eff of rawEffects) {
    if (eff.type === 'DROP_SHADOW' || eff.type === 'INNER_SHADOW') {
      effects.push({
        type: eff.type,
        offsetX: round1(eff.offset?.x ?? 0),
        offsetY: round1(eff.offset?.y ?? 0),
        blur: round1(eff.radius ?? eff.blur ?? 0),
        spread: round1(eff.spread ?? 0),
        color: eff.color || eff.colorHex || 'rgba(0,0,0,0.1)',
      });
    } else if (eff.type === 'BACKGROUND_BLUR' || eff.type === 'LAYER_BLUR') {
      effects.push({
        type: eff.type,
        blur: round1(eff.radius ?? eff.blur ?? 0),
      });
    }
  }
  if (effects.length > 0) out.effects = effects;

  // 4.5 填充直读与结构化: 纯色→color; 渐变/位图→fill 结构; paint_xxx 引用经 styles 表解析
  const fillRaw = resolveFillValue(node, styles)
  if (fillRaw) {
    const parsed = parseNeutralFill(fillRaw)
    if (parsed.type === 'solid') out.color = parsed.value
    else out.fill = parsed
  }

  // 4.6 描边 (MasterGo 平铺字段 strokeColor/strokeWidth/strokeAlign/strokeType; 颜色支持 paint 引用)
  const sw = Number(node.strokeWidth ?? 0)
  const strokeColor = resolvePaintRef(node.strokeColor, styles)
  if (sw > 0 || strokeColor) {
    out.stroke = {}
    if (strokeColor) out.stroke.color = strokeColor
    if (sw > 0) out.stroke.width = round1(sw)
    if (node.strokeAlign) out.stroke.align = String(node.strokeAlign).toLowerCase()
    if (node.strokeType) out.stroke.style = String(node.strokeType).toLowerCase()
  }

  // 5. 文本样式 (内联 textStyle 优先; 缺失时解析 dsl.styles 字体引用表)
  if (node.type === 'TEXT') {
    const ts = { ...(resolveFontRef(node, styles) || {}), ...(node.textStyle || {}) };
    if (ts.fontSize != null) out.fontSize = round1(Number(ts.fontSize));
    if (ts.fontWeight != null) {
      const w = Number(ts.fontWeight);
      if (!isNaN(w)) out.fontWeight = w;
    }
    if (ts.fontFamily != null) out.fontFamily = ts.fontFamily;
    // lineHeight 仅接受数值(auto/-1 等表示字体默认, 不臆造)
    const lh = Number(ts.lineHeight);
    if (ts.lineHeight != null && !isNaN(lh)) out.lineHeight = round1(lh);
    // letterSpacing: 数值直读; "2%" 百分比字串按字号换算为 px
    if (ts.letterSpacing != null) {
      let lsSp = Number(ts.letterSpacing);
      if (isNaN(lsSp) && typeof ts.letterSpacing === 'string' && ts.letterSpacing.trim().endsWith('%')) {
        lsSp = (parseFloat(ts.letterSpacing) / 100) * (out.fontSize || 14);
      }
      if (!isNaN(lsSp)) out.letterSpacing = round1(lsSp);
    }
    if (ts.textAlign != null) out.textAlign = ts.textAlign;
  }

  return out;
}

/** paint 引用解析: "paint_xxx" → styles 表值(数组取首个); 支持 {url} 图片对象形态; 其余字符串原样返回 */
function resolvePaintRef(ref, styles) {
  if (ref == null || ref === '') return null
  if (typeof ref === 'string' && /^paint_/.test(ref)) {
    const def = styles && typeof styles === 'object' ? styles[ref] : null
    const v = def && typeof def === 'object' ? (def.value ?? null) : def ?? null
    const first = Array.isArray(v) ? v[0] : v
    if (first && typeof first === 'object') {
      // 图片型 paint: {url, filters?} — 返回 url, 由 parseNeutralFill 归一为 image fill
      if (typeof first.url === 'string' && first.url) return first.url
      return null
    }
    return typeof first === 'string' ? first : null
  }
  return typeof ref === 'string' ? ref : null
}

/** 节点填充取值: _color 优先, 其次字面量 fill(paint 引用解析); 无则 null */
function resolveFillValue(node, styles) {
  if (typeof node._color === 'string' && node._color) return node._color
  if (typeof node.fill === 'string' && node.fill) return resolvePaintRef(node.fill, styles)
  return null
}

/**
 * 中立填充解析 (parseNeutralFill): 填充字符串 → 结构化事实, 不绑定任何技术栈。
 * - url(...) → {type:'image', src}                      位图/资源引用
 * - linear-gradient(angle, stops...) →
 *     {type:'gradient', kind:'linear', angle, stops:[{color, position(%)}]}
 *     颜色支持 #RGB/#RRGGBB/#RRGGBBAA/rgb()/rgba(); stop 缺省按序均布补齐
 * - 其余 → {type:'solid', value}
 */
function parseNeutralFill(str) {
  const s = String(str ?? '').trim()
  if (!s) return null
  if (/^url\(/i.test(s)) return { type: 'image', src: s }
  // 纯 http(s) 资源 URL(图片型 paint 引用解析产物) → image
  if (/^https?:\/\/\S+$/i.test(s)) return { type: 'image', src: s }
  const lg = s.match(/^linear-gradient\(\s*([^,]+?)\s*,([\s\S]+)\)$/i)
  if (lg) {
    const stops = []
    const stopRe = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|\b[a-zA-Z]+\b)\s*([0-9.]+%)?/g
    for (const m of lg[2].matchAll(stopRe)) {
      stops.push({ color: m[1], ...(m[2] != null ? { position: parseFloat(m[2]) } : {}) })
    }
    if (stops.length >= 2) {
      stops.forEach((st, i) => { if (st.position == null) st.position = round1((i / (stops.length - 1)) * 100) })
      return { type: 'gradient', kind: 'linear', angle: parseGradientAngle(lg[1]), stops }
    }
  }
  return { type: 'solid', value: s }
}

/** 渐变方向词/角度 → 统一角度(度, 顺时针, 0=向上) */
function parseGradientAngle(str) {
  const t = String(str).trim().toLowerCase()
  const deg = t.match(/^(-?[0-9.]+)deg$/)
  if (deg) return round1(Number(deg[1]))
  const dir = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to bottom right': 135, 'to bottom left': 225, 'to top left': 315 }
  return dir[t] != null ? dir[t] : 180
}

/**
 * 富文本逐 run 样式 (richTextRuns): text 为多段且各段字体参数不同质时返回
 * [{text, fontSize?, fontWeight?, lineHeight?, letterSpacing?}], 否则 null
 * (同质混排只留整串字段, 防冗余数据污染下游)。
 */
function richTextRuns(node, styles) {
  if (!Array.isArray(node.text) || node.text.length < 2) return null
  const runs = []
  for (const t of node.text) {
    if (!t || typeof t.text !== 'string') continue
    const def = t.font && styles && typeof styles === 'object' ? styles[t.font] : null
    const v = def && typeof def === 'object' ? (def.value || def) : null
    const s = v && typeof v === 'object' ? fontValToStyle(v) : {}
    runs.push({ text: t.text, ...s })
  }
  if (runs.length < 2) return null
  const sig = (r) => JSON.stringify([r.fontSize, r.fontWeight, r.lineHeight, r.letterSpacing])
  return new Set(runs.map(sig)).size > 1 ? runs : null
}

/** styles 表字体值 → 归一化样式字段(fontValToStyle) */
function fontValToStyle(v) {
  const out: Record<string, any> = {}
  if (v.size != null) out.fontSize = round1(Number(v.size))
  if (v.weight != null && !isNaN(Number(v.weight))) out.fontWeight = Number(v.weight)
  if (v.lineHeight != null && !isNaN(Number(v.lineHeight))) out.lineHeight = round1(Number(v.lineHeight))
  if (v.letterSpacing != null && !isNaN(Number(v.letterSpacing))) out.letterSpacing = round1(Number(v.letterSpacing))
  return out
}

/**
 * 解析 MasterGo dsl.styles 字体引用表: TEXT 节点经 text[].font 引用
 * {font_xxx: {value: {size, weight, lineHeight, letterSpacing, family}}}。
 * 返回归一化 textStyle 形状({fontSize,fontWeight,lineHeight,letterSpacing,fontFamily}),
 * 无引用或表缺失时返回 null。
 */
function resolveFontRef(node, styles) {
  const ref = Array.isArray(node.text) ? node.text.find((t) => t && t.font)?.font : null;
  if (!ref || !styles || typeof styles !== 'object') return null;
  const def = styles[ref];
  const v = def && typeof def === 'object' ? (def.value || def) : null;
  if (!v || typeof v !== 'object') return null;
  const out: Record<string, any> = {};
  if (v.size != null) out.fontSize = v.size;
  if (v.weight != null) out.fontWeight = v.weight;
  if (v.family != null) out.fontFamily = v.family;
  if (v.lineHeight != null) out.lineHeight = v.lineHeight;
  if (v.letterSpacing != null) out.letterSpacing = v.letterSpacing;
  return Object.keys(out).length ? out : null;
}

/** 容器吸收面积比: 子项面积须严格小于父项 × 此值才算可吸收子节点(dsl-clean 与 reverse 推理共用, 单一来源) */
export const CONTAINER_ABSORB_RATIO = 0.95

/**
 * 通用纯堆叠 DSL 反向推理真实布局架构 (reverseInferSemanticLayout)
 * 纯几何拓扑驱动: 无业务假设，从绝对坐标扁平堆叠图元中推导出生产级组件树与 Flex/Grid 嵌套结构
 *
 * 核心拓扑阶段:
 * 1. 视口与层级切片 (Z-Order Stratification): 提取底层背景与顶层悬浮覆盖层 (Overlay/Floating)
 * 2. 空间包含递归聚类 (Recursive Spatial Containment): 从小面积到大面积构建多级嵌套容器
 * 3. 容器内轴向投影解构 (Intra-Container Axis Projection): 自动聚合垂直文本列 (Column) 与水平图文槽位 (Row)
 * 4. 多列网格规整化 (Grid Matrix Regularization): 自动将同构多卡片提升为 Grid / Wrap
 */

// =====================================================================
// kit 基底独有(批3 合并保留): reconstructHierarchy/ROLES 重建层。inferGrid wrap 回退未保留 —— v2 裁决见 inferLayout 内注释
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
  // 几何字段访问统一 _ 前缀优先并兜底缺省 0(与 cluster 内核约定一致):
  // undefined 参与数值比较产生 NaN(恒 false), 会静默误判角色 —— 此前
  // `first._y + first.height` 混用两套字段名即此类 bug。
  const gw = (n: any) => n._width ?? n.width ?? 0
  const gy = (n: any) => n._y ?? n.y ?? 0
  const gh = (n: any) => n._height ?? n.height ?? 0
  const first = band.items[0]
  // 带内含贴底全宽背景条(高度≤110) → TabBar(即使背景条未触发全宽条独立带规则)
  const bottomBg = band.items.find((n: any) => gw(n) >= canvas.width * 0.9 && gy(n) + gh(n) >= canvas.height - 12 && gh(n) <= 110)
  if (bottomBg && band.items.length >= 3) return ROLES.TAB_BAR
  if (band.fullWidth) {
    if (gy(first) <= 30) return ROLES.STATUS_BAR
    if (gy(first) + gh(first) >= canvas.height - 10) return ROLES.TAB_BAR
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
  // 同 bandRoleOf: 几何访问 _ 前缀优先 + 0 兜底, 防 undefined→NaN 恒 false 误判
  const gx = (n: any) => n._x ?? n.x ?? 0
  const gw = (n: any) => n._width ?? n.width ?? 0
  const gy = (n: any) => n._y ?? n.y ?? 0
  const gh = (n: any) => n._height ?? n.height ?? 0
  for (const ic of icons) {
    let best = null
    let bestDist = Infinity
    for (const lb of labels) {
      if (usedLabels.has(lb.id)) continue
      const dx = Math.abs(gx(lb) + gw(lb) / 2 - (gx(ic) + gw(ic) / 2))
      const dy = gy(lb) - (gy(ic) + gh(ic))
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

  const offCanvas = prepared.filter((n: any) => n._x + n._width > canvas.width + 8 || n._x < -8 || n._y < -8 || n._y + n._height > canvas.height + 8)
  stats.offCanvas = offCanvas.length
  const onCanvas = prepared.filter((n: any) => !offCanvas.includes(n))

  const backgrounds = onCanvas.filter((n: any) => isBackgroundRect(n, canvas))
  stats.background = backgrounds.length
  let rest = onCanvas.filter((n: any) => !backgrounds.includes(n))

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
    const kids = rest.filter((n: any) => {
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
  for (const c of rest.filter((n: any) => absorbedContainers.has(n.id) || standaloneContainers.has(n.id))) {
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
  const floaters = rest.filter((n: any) => !assigned.has(n.id) && !absorbedContainers.has(n.id) && !standaloneContainers.has(n.id))

  // 未被吸收的旋转节点 → 顶层 sticker(参与带状聚类前剔除)
  const stickers = floaters.filter((n: any) => Math.abs(n._rotation || 0) > 0.5)
  stats.sticker = stickers.length
  const bandFloaters = floaters.filter((n: any) => !stickers.includes(n))

  // ---- 2. 带状聚类 + 带内分组 ----
  const bands = clusterBandsAdaptive(bandFloaters, canvas)
  stats.band = bands.length

  const children = []
  const pushNode = (n: any) => children.push(buildLeaf(n))
  for (const band of bands) {
    const role = bandRoleOf(band, canvas)
    // TabBar 特判: 全宽背景条 + icon/label 对
    if (role === ROLES.TAB_BAR) {
      const bg = band.items.filter((n: any) => n._width >= canvas.width * 0.9)
      const items = band.items.filter((n: any) => !bg.includes(n))
      const icons = items.filter((n: any) => n.type !== 'TEXT' && n._height <= 30 && n._height >= 14 && n._width <= 40)
      const labels = items.filter((n: any) => n.type === 'TEXT')
      const restItems = items.filter((n: any) => !icons.includes(n) && !labels.includes(n))
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
      const bandKids = [...tabItems, ...restItems.map((n: any) => ({ id: n.id, x: n._x - bandMinX(band), y: n._y - bandMinY(band), width: n._width, height: n._height }))]
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
    const relKids = band.items.map((n: any) => ({
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
      children: clusterCols(band.items).map((c: any) => {
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
            children: sorted.map((n: any) => ({ id: n.id, x: n._x - bandMinX(band), y: n._y - bandMinY(band), width: n._width, height: n._height })),
          }),
          children: sorted.map(buildLeaf),
        }
      }),
    })
  }

  // ---- 最终树: 背景 + 独立块 + 带块按 y 排序 ----
  const backgroundLeaves = backgrounds.map((n: any) => ({ ...buildLeaf(n), role: ROLES.BACKGROUND }))
  const stickerLeaves = stickers.map((n: any) => ({ ...buildLeaf(n), role: ROLES.STICKER }))
  const offCanvasLeaves = offCanvas.map((n: any) => ({ ...buildLeaf(n), role: ROLES.OFF_CANVAS }))
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


export { round1, mode, inferLayout, simulateFlex, clusterByAxis, inferGridPattern, inferStaggeredDeck, isFloatingCapsule, inferViewportMetadata, extractExactStyles, parseNeutralFill, reconstructHierarchy, ROLES, MACHINE_NAME_RE, semanticNodeName, richTextRuns };
