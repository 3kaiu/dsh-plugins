'use strict'

import { extractDesignTokens } from "./design-tokens.ts";
import { measurerInfo, predictTextLayout } from "./text-metrics.ts";
import { verifyLayoutTruth } from "./yoga-truth.ts";
import { detectSiblingComponentGroups } from "./repeat.ts";
import { resolveDesignScale, applyDesignScale } from "./scale.ts";

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
 */

const TOL = 2 // 像素容差(整数坐标设计稿)
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
        reason: '单子节点水平居中',
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
        reason: '单子节点垂直居中',
      }, cw, ch, stable, absolutes)
    }
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes], reason: '单子节点无对齐信号' }
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
    // 行列都不成立 → absolute(stack 语义), 几何由 bounds 差值守恒
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
  let alignItems = inferCrossAlign(stable, isRow, TOL)

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
  const mainSizing = Math.abs(mainExtent - mainContainer) <= TOL ? 'fixed' : 'auto'
  const crossSizing = Math.abs(crossExtent - crossContainer) <= TOL ? 'fixed' : 'auto'

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
  if (maxDelta > 2) {
    return { position: 'absolute', confidence: 0.4, absolutes: [...absolutes], reason: 'flex模拟偏差>2px,降级保真' }
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
function extractExactStyles(node, styles = {}) {
  if (!node) return {};
  const out = {};

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
  const out = {}
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
  const out = {};
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
function reverseInferSemanticLayout({ canvas, nodes = [] }) {
  if (!canvas || nodes.length === 0) return { root: null, tree: [], backgrounds: [], floatings: [], gridInfo: null, structuredTree: [] };
  const cw = canvas.width;
  const ch = canvas.height;

  // 1. 节点几何归一化
  const items = nodes.map((n, i) => {
    const ls = n.layoutStyle || {};
    const x = ls.relativeX ?? ls.x ?? n.x ?? 0;
    const y = ls.relativeY ?? ls.y ?? n.y ?? 0;
    const w = ls.width ?? n.width ?? 0;
    const h = ls.height ?? n.height ?? 0;
    const rot = ls.rotate ?? n.rotation ?? 0;
    return {
      id: n.id || ('node_' + i),
      name: n.name || '',
      type: n.type || 'FRAME',
      x: round1(x),
      y: round1(y),
      width: round1(w),
      height: round1(h),
      rotation: round1(rot),
      borderRadius: n.borderRadius ?? ls.borderRadius,
      effects: n.effects ?? n.styles?.effects ?? [],
      text: n.text,
      textStyle: n.textStyle,
      fill: n.fill,
      // _color 透传(审计连带发现): 蓝图 backgrounds 序列化取 b.fill || b._color,
      // 此处若丢弃 _color, 纯色底稿的背景 fill 会静默变空(快照/下游重建失去底色)
      _color: n._color ?? undefined,
      raw: n,
    };
  });

  // 2. 分离悬浮层 (Floating Capsule / Overlay) 与 背景层 (Background)
  const floatings = [];
  const backgrounds = [];
  const contentNodes = [];

  for (const item of items) {
    // 背景判定(审计 P1 修复): 原条件②只看"全宽 + 贴顶(y≤0)", 会把 375×64 的通栏
    // 顶栏/横幅误吞为背景 —— 从 tree 消失且序列化丢坐标(styleDiff 还对其豁免)。
    // 现要求全宽之外再满足纵向覆盖 ≥50% 画布高才认作背景; 诚实边界: 半屏以上的
    // 贴顶大图(hero 图)几何上仍难与背景区分, 需图层命名/切图语义辅助判定。
    const isBg = (item.width >= cw * 0.95 && item.height >= ch * 0.95) ||
                 (item.width >= cw && item.height >= ch * 0.5 && item.y <= 0);
    const isFloat = isFloatingCapsule({ _x: item.x, _y: item.y, _width: item.width, _height: item.height }, canvas);

    if (isBg) {
      backgrounds.push(item);
    } else if (isFloat) {
      floatings.push(item);
    } else {
      contentNodes.push(item);
    }
  }

  // 3. 全局包含聚合 (从小到大排序容器候选; 面积相同按 z-order/DSL 顺序)
  // 消歧策略: 面积升序保证子节点优先被"最小充分容器"吸收 (slack 最小), z-order 作次级排序保证确定性
  // absorbedMap 本身构成一棵森林 (parent -> 直接几何子节点), 递归结构化直接消费该森林
  const zOrder = new Map(contentNodes.map((n, i) => [n.id, i]));
  const containerCandidates = contentNodes.filter(c => {
    return (c.type === 'FRAME' || c.type === 'GROUP' || (c.width > 50 && c.height > 30)) && !c.text;
  }).sort((a, b) => ((a.width * a.height) - (b.width * b.height)) || ((zOrder.get(a.id) ?? 0) - (zOrder.get(b.id) ?? 0)));

  const absorbedMap = new Map(); // parentId -> [childItems]
  const assignedSet = new Set();

  for (const parent of containerCandidates) {
    if (assignedSet.has(parent.id)) continue;
    const children = [];
    for (const child of contentNodes) {
      if (child.id === parent.id || assignedSet.has(child.id)) continue;
      // 空间几何包围判定 (带 2px 容差)
      const isInside = child.x >= parent.x - 2 &&
                       child.y >= parent.y - 2 &&
                       (child.x + child.width) <= (parent.x + parent.width + 2) &&
                       (child.y + child.height) <= (parent.y + parent.height + 2);
      if (isInside && (child.width * child.height) < (parent.width * parent.height * CONTAINER_ABSORB_RATIO)) {
        children.push(child);
      }
    }
    if (children.length > 0) {
      absorbedMap.set(parent.id, children);
      for (const ch of children) assignedSet.add(ch.id);
    }
  }

  // 4. 构建顶层流式带与卡片
  const topLevelItems = contentNodes.filter(n => !assignedSet.has(n.id));

  // 5. 检查顶层卡片中是否形成多列网格 (Grid Matrix)
  const gridInfo = inferGridPattern(topLevelItems);

  // 6. 递归容器结构化: 沿 absorbedMap 森林逐层下行, 每层 [文本列聚合 -> inferLayout], 直到叶子
  const MAX_STRUCTURE_DEPTH = 8;

  // 文本列聚合: 内部垂直排列的文本节点子集聚合为 ColumnGroup (作用于已结构化的子节点)
  function aggregateTextColumn(container, children) {
    const textKids = children.filter(c => (c.text || c.type === 'TEXT') && !c.isSyntheticGroup);
    const nonTextKids = children.filter(c => !((c.text || c.type === 'TEXT') && !c.isSyntheticGroup));

    if (textKids.length >= 2) {
      const xs = textKids.map(t => t.x ?? t.bbox?.x ?? 0);
      if ((Math.max(...xs) - Math.min(...xs)) <= 16) {
        const sortedTexts = [...textKids].sort((a, b) => (a.y ?? a.bbox?.y ?? 0) - (b.y ?? b.bbox?.y ?? 0));
        const minY = sortedTexts[0].y ?? sortedTexts[0].bbox?.y ?? 0;
        const minX = Math.min(...xs);
        const colBBox = {
          x: minX,
          y: minY,
          width: Math.max(...textKids.map(t => (t.x ?? t.bbox?.x ?? 0) + (t.width ?? t.bbox?.width ?? 0))) - minX,
          height: ((sortedTexts[sortedTexts.length - 1].y ?? 0) + (sortedTexts[sortedTexts.length - 1].height ?? 0)) - minY,
        };
        // 逐对间距: 行距不均匀时平均值会产生累积漂移(真值引擎可检出),
        // 非均匀 -> 输出 spacing 数组精确编码每一行间距; 均匀 -> 单一 gap
        const pairGaps = [];
        for (let i = 1; i < sortedTexts.length; i++) {
          const prev = sortedTexts[i - 1];
          const cur = sortedTexts[i];
          pairGaps.push(round1((cur.y ?? cur.bbox?.y ?? 0) - ((prev.y ?? prev.bbox?.y ?? 0) + (prev.height ?? prev.bbox?.height ?? 0))));
        }
        const gapsUniform = pairGaps.every(g => Math.abs(g - pairGaps[0]) <= 0.5);
        const textColumnNode = {
          id: container.id + '_text_column',
          name: 'text-content-column',
          type: 'FRAME',
          isSyntheticGroup: true,
          role: 'column-group',
          layout: gapsUniform
            ? { flexDirection: 'column', gap: pairGaps[0], width: round1(colBBox.width), height: round1(colBBox.height) }
            : { flexDirection: 'column', gap: null, spacing: pairGaps, width: round1(colBBox.width), height: round1(colBBox.height) },
          bbox: colBBox,
          children: sortedTexts,
        };
        return [...nonTextKids, textColumnNode].sort((a, b) => (a.x ?? a.bbox?.x ?? 0) - (b.x ?? b.bbox?.x ?? 0));
      }
    }
    return children;
  }

  function structureNode(item, depth = 0) {
    const kids = absorbedMap.get(item.id);
    if (!kids || kids.length === 0) {
      return { ...item, isContainer: false, children: [] };
    }
    // 深度上限: 降级为 absolute 容器, 保留原始 children 防止节点丢失
    if (depth >= MAX_STRUCTURE_DEPTH) {
      return { ...item, isContainer: true, layout: { position: 'absolute', confidence: 0.3, reason: '结构深度上限' }, children: kids };
    }
    const structuredKids = kids.map((k) => structureNode(k, depth + 1));
    const resolvedChildren = aggregateTextColumn(item, structuredKids);
    const layout = inferLayout({
      container: { width: item.width, height: item.height },
      children: resolvedChildren.map((k) => ({
        id: k.id,
        x: (k.x ?? k.bbox?.x ?? 0) - item.x,
        y: (k.y ?? k.bbox?.y ?? 0) - item.y,
        width: k.width ?? k.bbox?.width ?? 0,
        height: k.height ?? k.bbox?.height ?? 0,
        rotation: k.rotation ?? 0,
      })),
    });
    return {
      ...item,
      isContainer: true,
      layout,
      children: resolvedChildren,
      _layoutConfidence: layout?.confidence ?? 0,
    };
  }

  const structuredTree = topLevelItems.map((item) => structureNode(item, 0));

  return {
    canvas: { width: cw, height: ch },
    backgrounds,
    floatings,
    gridInfo,
    structuredTree,
  };
}


/**
 * 方向 2: 极端退化形态与脏数据防御清洗 (sanitizeDslNodes)
 * 过滤 0px 极细线、NaN/null、重叠重复幽灵图层 (Ghost Layers)、负尺寸异常
 * 防御性展平: 嵌套树输入自动转为扁平绝对坐标(契约要求扁平, 嵌套直传曾静默丢子树)
 */
function sanitizeDslNodes(nodes = [], canvas = { width: 375, height: 812 }) {
  if (!Array.isArray(nodes)) return [];
  // 展平: 子树相对坐标逐层累加为绝对坐标; 扁平输入(children 缺失/空)原样通过
  const flatNodes = [];
  const walkFlat = (n, ox, oy, parentObj) => {
    if (!n || typeof n !== 'object') return;
    const ls = n.layoutStyle || {};
    const ax = (ls.relativeX ?? ls.x ?? n.x ?? 0) + ox;
    const ay = (ls.relativeY ?? ls.y ?? n.y ?? 0) + oy;
    const kids = Array.isArray(n.children) ? n.children : [];
    const w = ls.width ?? n.width ?? 0;
    const h = ls.height ?? n.height ?? 0;
    const self = { ...n, children: undefined, layoutStyle: { ...(n.layoutStyle || {}), relativeX: ax, relativeY: ay }, _ax: ax, _ay: ay, _aw: w, _ah: h };
    if (parentObj) {
      self._parentBox = { x: parentObj._ax, y: parentObj._ay, width: parentObj._aw, height: parentObj._ah };
      const cu = parentObj._childUnion ?? (parentObj._childUnion = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
      cu.x1 = Math.min(cu.x1, ax); cu.y1 = Math.min(cu.y1, ay);
      cu.x2 = Math.max(cu.x2, ax + w); cu.y2 = Math.max(cu.y2, ay + h);
    }
    flatNodes.push(self);
    for (const k of kids) walkFlat(k, ax, ay, self);
  };
  for (const n of nodes) walkFlat(n, 0, 0, null);

  const seenKeys = new Set();
  const clean = [];
  for (const n of flatNodes) {
    if (!n) continue;
    const ls = n.layoutStyle || {};
    let x = ls.relativeX ?? ls.x ?? n.x ?? 0;
    let y = ls.relativeY ?? ls.y ?? n.y ?? 0;
    let w = ls.width ?? n.width ?? 0;
    let h = ls.height ?? n.height ?? 0;
    let rot = ls.rotate ?? n.rotation ?? 0;
    if (isNaN(x) || !isFinite(x)) x = 0;
    if (isNaN(y) || !isFinite(y)) y = 0;
    if (isNaN(w) || !isFinite(w)) w = 0;
    if (isNaN(h) || !isFinite(h)) h = 0;
    if (isNaN(rot) || !isFinite(rot)) rot = 0;
    if (w < 0) { x += w; w = Math.abs(w); }
    if (h < 0) { y += h; h = Math.abs(h); }
    if (w <= 0.1 && h <= 0.1 && !n.text && n.type !== "TEXT") continue;
    const key = [round1(x), round1(y), round1(w), round1(h), n.type || "", n.name || ""].join("_");
    if (seenKeys.has(key) && !n.text && n.type !== "TEXT") continue;
    seenKeys.add(key);
    clean.push({ ...n, x: round1(x), y: round1(y), width: round1(w), height: round1(h), rotation: round1(rot) });
  }
  return clean;
}
/**
 * 中立布局指令: 蓝图的唯一布局表示(不含任何技术栈字面量)。
 * role: row|column|stack|box; 对齐/位置为通用枚举;
 * gap: number(等距) | number[](相邻对间距); padding: [top,right,bottom,left] 数值数组。
 * 技术栈代码(Flutter/CSS/Web)一律由下游基于该结构生成。
 *
 * 紧凑约定(省字节, 防双源漂移):
 * - justifyContent/alignItems 缺省=start; gap 缺省=0; padding 缺省=[0,0,0,0], 非缺省才输出
 * - 尺寸唯一真值是 bounds; layout 不重复携带 width/height
 */
function neutralLayoutOf(layoutInfo = {}, exactStyles = {}) {
  const li = layoutInfo || {};
  const normEnd = (v) => (v === 'flex-end' ? 'end' : v === 'flex-start' ? 'start' : v);
  const out = {
    role: li.position === 'absolute' ? 'stack'
      : li.flexDirection === 'row' ? 'row'
      : li.flexDirection === 'column' ? 'column' : 'box',
    position: li.position === 'absolute' ? 'absolute' : 'flex',
  };
  // 推理溯源: confidence/reason 是算法推断元数据(非设计稿事实), 帮 LLM 评估布局可信度
  if (Number.isFinite(li.confidence)) out.confidence = round1(li.confidence);
  if (typeof li.reason === 'string' && li.reason) out.reason = li.reason;
  const jc = normEnd(li.justifyContent);
  if (jc && jc !== 'start') out.justifyContent = jc;
  const ai = normEnd(li.alignItems);
  if (ai && ai !== 'start') out.alignItems = ai;
  if (Array.isArray(li.spacing)) out.gap = li.spacing;
  else if (Number(li.gap) > 0) out.gap = Number(li.gap);
  if (Array.isArray(li.padding) && li.padding.some((p) => p > 0.01)) out.padding = li.padding;
  if (exactStyles.borderRadius != null) out.borderRadius = exactStyles.borderRadius;
  if (Array.isArray(exactStyles.effects) && exactStyles.effects.length > 0) out.effects = exactStyles.effects;
  return out;
}

/**
 * ============================================================================
 * LLM 最优协作范式: 紧凑代码蓝图生成器 (generateCodeBlueprint)
 * 解决 Raw DSL 导致 LLM Context 爆炸与多轮工具调用耗时的问题
 * 将海量原始 DSL (200KB+) 压缩并提炼为结构化、零歧义、Token 节省 85% 的代码蓝图
 * 输出为技术栈中立规范: 布局/视觉全部是纯数据, 代码生成由下游按目标栈完成
 * ============================================================================
 */
function generateCodeBlueprint({ canvas, nodes = [], styles = null, scale = null }) {
  // 0. 倍率归一(@2x/@3x 画板 → @1x 逻辑像素): 必须在推理前做 ——
  //    管线全部容差(TOL/带聚类/胶囊几何)按逻辑像素标定, 事后缩放蓝图会语义失配。
  //    归一实际发生时, canvas.scale 记录溯源事实({factor, source, confidence?})。
  const resolvedScale = resolveDesignScale(scale, { canvas, nodes, styles: styles || {} });
  let scaleMeta = null;
  if (resolvedScale && resolvedScale.effective) {
    const f = 1 / resolvedScale.factor;
    ({ nodes, styles } = applyDesignScale(nodes, styles || {}, f));
    canvas = {
      ...canvas,
      width: round1((canvas.width || 0) * f),
      height: round1((canvas.height || 0) * f),
    };
    scaleMeta = { factor: resolvedScale.factor, source: resolvedScale.source };
    if (resolvedScale.source === 'inferred') scaleMeta.confidence = resolvedScale.confidence;
  }

  // 0. 裁剪语义预处理(A2): 展平前沿原始树给蒙版本体形状打标(_maskShape + _clipRadius)。
  //    展平重建是纯几何驱动, 原 GROUP 分组不可靠(同 bbox 蒙版 GROUP 可能被吸收不存活),
  //    故标记必须跟 mask 形状自身走; 容器归属由 nodeToBlueprint 递归时按"直接子级含蒙版形状"回填。
  const markClipSemantics = (list) => {
    for (const n of Array.isArray(list) ? list : []) {
      if (!n || typeof n !== 'object') continue;
      if (n.mask === 'outline' || n.mask === true) {
        n._maskShape = true;
        const r = extractExactStyles(n, styles || {}).borderRadius ?? n.borderRadius ?? (n.layoutStyle || {}).borderRadius;
        if (r != null) n._clipRadius = r;
      }
      markClipSemantics(Array.isArray(n.children) ? n.children : []);
    }
  };
  markClipSemantics(nodes);

  // 图片显示框语义(A3): 素材位图越出其源父框可视区(Skill 高频坑: 图片原始尺寸≠显示框)。
  // 源父几何由展平段以 _parentBox 保留(ingest/sanitize 两级展平均挂), 此处对扁平列表单趟检测;
  // visibleRect 为父框可视部分在素材自身坐标系下的矩形, 下游按 cover 映射, 无需理解层级。
  const imageFillOf = (n) => {
    if (n.type === 'IMAGE') return true;
    if (typeof n.fill === 'string' && /url\(|image/.test(n.fill)) return true;
    try { return extractExactStyles(n, styles || {}).fill?.type === 'image'; } catch { return false; }
  };
  const markImageCrop = (list) => {
    for (const n of Array.isArray(list) ? list : []) {
      if (!n || typeof n !== 'object') continue;
      const pb = n._parentBox;
      if (!pb || !imageFillOf(n)) continue;
      const cls = n.layoutStyle || {};
      const cx = cls.relativeX ?? cls.x ?? n.x ?? 0;
      const cy = cls.relativeY ?? cls.y ?? n.y ?? 0;
      const cw2 = cls.width ?? n.width ?? 0;
      const chh = cls.height ?? n.height ?? 0;
      const wx = Math.max(cx, pb.x ?? 0);
      const wy = Math.max(cy, pb.y ?? 0);
      const vw = Math.min(cx + cw2, (pb.x ?? 0) + (pb.width ?? 0)) - wx;
      const vh = Math.min(cy + chh, (pb.y ?? 0) + (pb.height ?? 0)) - wy;
      if (vw > 0 && vh > 0 && (vw < cw2 - 0.5 || vh < chh - 0.5)) {
        n._imageCrop = { mode: 'cover', visibleRect: { x: round1(wx - cx), y: round1(wy - cy), width: round1(vw), height: round1(vh) } };
      }
    }
  };

  // 1. 脏数据防御清洗
  const cleanNodes = sanitizeDslNodes(nodes, canvas);
  markImageCrop(cleanNodes);

  // 2. 纯几何反向推理拓扑树
  const layoutResult = reverseInferSemanticLayout({ canvas, nodes: cleanNodes });

  // 3. 递归将结构树序列化为紧凑蓝图
  let semanticRenameSeq = 0;
  let semanticRenames = 0;
  function nodeToBlueprint(node) {
    const exactStyles = extractExactStyles(node.raw || node, styles || {});

    const rawNode = node.raw || node;
    const rawName = String(rawNode?.name ?? node?.name ?? '').trim();
    const nameSeq = ++semanticRenameSeq;
    const cleanName = semanticNodeName(node, rawNode, nameSeq);
    if (cleanName !== rawName) semanticRenames++;

    const bp = {
      id: node.id,
      name: cleanName,
      type: node.type,
      layout: neutralLayoutOf(node.layout || {}, exactStyles),
      bounds: {
        x: node.x ?? node.bbox?.x ?? 0,
        y: node.y ?? node.bbox?.y ?? 0,
        width: node.width ?? node.bbox?.width ?? exactStyles.width,
        height: node.height ?? node.bbox?.height ?? exactStyles.height,
      },
    };

    // 文本节点细节
    if (node.text || node.type === 'TEXT') {
      bp.text = Array.isArray(node.text) ? node.text.map(t => t.text).join('') : (typeof node.text === 'string' ? node.text : '');
      bp.fontSize = exactStyles.fontSize;
      bp.fontWeight = exactStyles.fontWeight;
      bp.lineHeight = exactStyles.lineHeight;
      bp.letterSpacing = exactStyles.letterSpacing;
      bp.textAlign = exactStyles.textAlign;
      bp.fontFamily = exactStyles.fontFamily;
      // 富文本混排: 各 run 字体参数不同质时保留逐 run 样式(同质仅留整串字段, 防冗余)
      const runs = richTextRuns(node, styles || {});
      if (runs) bp.textRuns = runs;
      // 单行语义: DSL textMode=single-line 时下游必须禁用换行(否则边界宽度文字会折行裁字)
      if (node.textMode === 'single-line' || node.raw?.textMode === 'single-line') {
        bp.softWrap = false;
        bp.maxLines = 1;
      }
      // 文本度量(增强): 实测宽度与换行预测(字体模式精确 / 启发式兜底), 附字号交叉验证(A6)
      if (bp.text) {
        const maxW = exactStyles.width || node.layoutStyle?.width || 0;
        const p = predictTextLayout({ text: bp.text, fontSize: bp.fontSize || 14, maxWidth: maxW, letterSpacing: bp.letterSpacing || 0 });
        bp.measured = { singleLineWidth: p.singleLineWidth, fitsOneLine: p.fitsOneLine, wrappedLines: p.lines };
        // 字号交叉验证(A6): declared 字号下的实测文本宽 vs 框宽, 加框高信号 → fontConfidence/fontNote。
        // Skill 经验: 单行文本装不下=字体缺失或字号失真; 框高≈字号=装饰字体(如 JoonFont 数值大字)。
        const declaredFs = bp.fontSize ?? (Number(rawNode.fontSize) || null);
        if (declaredFs != null && maxW > 0 && p.singleLineWidth != null) {
          const ratio = p.singleLineWidth / maxW;
          let fc = ratio <= 1.02 ? 1 : null;
          let note;
          if (fc == null && bp.softWrap === false && ratio > 1.05) {
            fc = 0.3;
            note = `单行文本实测宽超框 ${Math.round(ratio * 100)}% — 字体缺失或字号失真, 以 bounds 高度反推字号核对`;
          } else if (fc == null) {
            fc = 0.8;
          }
          const boxH = bp.bounds.height;
          if (boxH > 0 && Math.abs(boxH - declaredFs) <= Math.max(1, declaredFs * 0.06)) {
            note = 'decorative: 框高≈字号(装饰字体特征)';
            fc = Math.max(fc ?? 0, 0.9);
          }
          bp.measured.fontConfidence = Math.round(fc * 100) / 100;
          if (note) bp.measured.fontNote = note;
        }
      }
    }
    // 样式通道(可选字段, 缺省即无): 纯色 color / 渐变·位图 fill / 描边 stroke / 旋转 / 不透明度
    if (exactStyles.color) bp.color = exactStyles.color;
    if (exactStyles.fill) bp.fill = exactStyles.fill;
    if (exactStyles.stroke) bp.stroke = exactStyles.stroke;
    if (exactStyles.rotation != null) bp.rotation = exactStyles.rotation;
    if (exactStyles.opacity != null) bp.opacity = exactStyles.opacity;
    // 裁剪通道(A2): mask 形状自身即蒙版裁剪边界(形状=bounds+radius), 不依赖容器归属
    // (展平重建后同 bbox 嵌套组会塌散, 挂在形状上任何树形下都成立); clipShape=true 表示非可见内容
    if (rawNode._maskShape) {
      bp.clipShape = true;
      bp.layout.clip = { enabled: true, source: 'mask' };
      if (rawNode._clipRadius != null) bp.layout.clip.radius = rawNode._clipRadius;
    }
    // 图片显示框(A3): 素材位图仅 visibleRect 区域可见(预处理沿原始树检出)
    if (rawNode._imageCrop) {
      bp.fill = { ...(bp.fill || { type: 'image' }), crop: rawNode._imageCrop };
    }
    // 合并矢量(A4): _mergedVector 组是单个合并图标; 无 svgKey 时为"待导出矢量", 按 id 从设计侧补切图
    if (rawNode._mergedVector === true) bp.mergedVector = true;
    // 容器/内容尺寸冲突(A5): 源树中直接子内容外接盒明显越出本节点 bounds = 该节点是裁剪显示框,
    // 内容真实尺寸更大(Skill: 以子元素真实尺寸为准)。bounds 是守恒真值不改, 仅记录冲突事实。
    const cu = rawNode._childUnion;
    if (cu && Number.isFinite(cu.x1) && (cu.x2 - cu.x1 > (node.width ?? 0) + 8 || cu.y2 - cu.y1 > (node.height ?? 0) + 8)) {
      bp.contentClipped = { width: round1(cu.x2 - cu.x1), height: round1(cu.y2 - cu.y1) };
    }    // 矢量图标引用: PATH/LAYER 节点的切图键(design 侧资源, 下游经导出表 id->svg 解析)。
    // 几何归一化重建会丢 svg 字段, 从 node.raw(原节点)回读; svgName 是语义补充。
    const svgRef = rawNode.svgShortKey || rawNode.svgKey || node.svgShortKey || node.svgKey;
    if (svgRef) bp.svgKey = svgRef;
    // svgName 是语义补充, 但导出里也常见机器名(编组/组 xxx) —— 同一净化正则过滤
    const rawSvgName = String(rawNode.svgName || node.svgName || '');
    if (rawSvgName && !MACHINE_NAME_RE.test(rawSvgName)) bp.svgName = rawSvgName;

    // 递归子节点
    if (Array.isArray(node.children) && node.children.length > 0) {
      bp.children = node.children.map((c) => nodeToBlueprint(c));
    }

    return bp;
  }

  const floatingsBlueprint = layoutResult.floatings.map((n) => nodeToBlueprint(n));
  const blueprintTree = layoutResult.structuredTree.map((n) => nodeToBlueprint(n));

  // 3.5 页面级节奏: roots 在纵轴无重叠时聚合为 page column,
  //     section 间隙以逐对 spacing 精确表达(与 text_column 同构的机制)。
  //     无重叠判定不满足(多列/交叠画布)时维持 roots 原样, 下游按绝对定位处理。
  const buildPageShell = (roots) => {
    if (roots.length < 2) return { tree: roots, pageShell: null };
    const sorted = [...roots].sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0));
    const hasBounds = sorted.every((r) => r.bounds);
    // 纵轴无重叠 -> flow column(section 节奏以逐对 spacing 精确表达)
    let flowable = hasBounds;
    if (hasBounds) {
      for (let i = 1; i < sorted.length; i++) {
        const p = sorted[i - 1].bounds, c = sorted[i].bounds;
        if ((c.y ?? 0) < ((p.y ?? 0) + (p.height ?? 0)) - 0.5) { flowable = false; break; }
      }
    }
    // 页面壳 = 画布视口(而非内容包围盒): 画布外碎片(x<0 等)不参与定位原点,
    // 子项以画布绝对坐标差值定位, 语义与渲染视口一致
    const shellBounds = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    if (flowable) {
      const pairs = [];
      for (let i = 1; i < sorted.length; i++) {
        const p = sorted[i - 1].bounds, c = sorted[i].bounds;
        pairs.push(round1((c.y ?? 0) - ((p.y ?? 0) + (p.height ?? 0))));
      }
      const shell = {
        id: 'page_shell', name: 'page', type: 'FRAME', isSyntheticGroup: true, archetype: 'PAGE_COLUMN',
        layout: { role: 'column', position: 'flex', justifyContent: 'start', alignItems: 'start', gap: pairs, padding: [0, 0, 0, 0], width: shellBounds.width, height: shellBounds.height },
        bounds: shellBounds, children: sorted,
      };
      return { tree: [shell], pageShell: shell };
    }
    // 交叠 roots -> 页面级 Stack(绝对定位语义), 下游 Positioned 逐项还原
    const shell = {
      id: 'page_shell', name: 'page', type: 'FRAME', isSyntheticGroup: true, archetype: 'PAGE_STACK',
      layout: { role: 'stack', position: 'absolute', justifyContent: 'start', alignItems: 'start', gap: 0, padding: [0, 0, 0, 0], width: shellBounds.width, height: shellBounds.height },
      bounds: shellBounds, children: sorted,
    };
    return { tree: [shell], pageShell: shell };
  };
  const { tree: blueprintTreeOut, pageShell } = buildPageShell(blueprintTree);

  // 4. 全局回验门禁: 蓝图树 vs 清洗后原节点逐 id 比对绝对几何
  let diffReport = autoHealingLayoutDiff(cleanNodes, [...blueprintTree, ...floatingsBlueprint]);

  // 4.5 回验驱动降级: delta>2px 的子树不再信任其 flex 指令,
  // 责任容器(position 漂移)降级 absolute/Stack,尺寸漂移保持 directive 但标注供下游警惕
  let downgradedContainers = 0;
  if (diffReport.maxDelta > 2) {
    const offenderIds = new Set(diffReport.allOffenderIds || []);
    const mark = (bp) => {
      if (Array.isArray(bp.children)) {
        const hasOffender = (n) => offenderIds.has(n.id) || (n.children || []).some(hasOffender);
        if (hasOffender(bp) && (bp.layout?.role === 'row' || bp.layout?.role === 'column' || bp.layout?.position === 'flex')) {
          bp.layout = { ...bp.layout, role: 'stack', position: 'absolute', downgradeReason: 'diff>2px 回验降级' };
          downgradedContainers++;
        }
        for (const c of bp.children) mark(c);
      }
    };
    for (const root of [...blueprintTree, ...floatingsBlueprint]) mark(root);
    diffReport = { ...diffReport, downgradedContainers };
  }

  // 5. 布局真值自愈: Yoga 标准求解器回验 flex 推断(启发式公式之外的第二道独立门禁)。
  //    主轴失配的均匀 gap 容器 -> 精确化为逐对 spacing 数组(与设计几何逐项对齐), 复验收敛。
  //    纯中立机制: 只改写蓝图的数值字段, 不引入任何技术栈语义。
  let truthReport = verifyLayoutTruth({ tree: blueprintTree, floatings: floatingsBlueprint });
  let truthRefinedContainers = 0;
  if (truthReport && truthReport.worst.length > 0) {
    const badIds = new Set(truthReport.worst.map((w) => w.containerId));
    const refine = (bp) => {
      if (!bp || typeof bp !== "object") return;
      const ly = bp.layout || {};
      const kids = Array.isArray(bp.children) ? bp.children : [];
      if (badIds.has(bp.id) && (ly.role === "row" || ly.role === "column") && kids.length >= 2 && typeof ly.gap === "number") {
        const isRow = ly.role === "row";
        const pairs = [];
        let ok = true;
        for (let i = 1; i < kids.length; i++) {
          const p = kids[i - 1].bounds, c = kids[i].bounds;
          if (!p || !c) { ok = false; break; }
          pairs.push(isRow
            ? round1((c.x ?? 0) - ((p.x ?? 0) + (p.width ?? 0)))
            : round1((c.y ?? 0) - ((p.y ?? 0) + (p.height ?? 0))));
        }
        if (ok && pairs.length) {
          bp.layout = { ...ly, gap: pairs, gapRefined: "truth-driven" };
          truthRefinedContainers++;
        }
      }
      for (const c of kids) refine(c);
    };
    for (const root of [...blueprintTree, ...floatingsBlueprint]) refine(root);
    truthReport = verifyLayoutTruth({ tree: blueprintTree, floatings: floatingsBlueprint });
    truthReport.refinedContainers = truthRefinedContainers;

    // 第二级: 交叉轴残差校正 —— 求解位置 vs 设计位置的差值编码为子项 crossOffset(px),
    // 交由下游以 margin/偏移表达。仅 start 对齐容器参与(center/end 语义会互相干扰)。
    if (truthReport.worst.length > 0) {
      const byId = new Map();
      const idx = (bp) => { if (!bp || !bp.id || byId.has(bp.id)) return; byId.set(bp.id, bp); for (const c of bp.children || []) idx(c); };
      for (const root of [...blueprintTree, ...floatingsBlueprint]) idx(root);
      let crossCorrected = 0;
      for (const w of truthReport.worst) {
        const container = byId.get(w.containerId);
        const child = byId.get(w.childId);
        if (!container || !child || !w.solved) continue;
        const isRow = container.layout?.role === "row";
        const cross = isRow ? "y" : "x";
        const off = round1((w.expected?.[cross] ?? 0) - (w.solved[cross] ?? 0));
        if (off === 0) continue;
        // 语义: 布局后交叉轴平移 px。start 对齐可被 Yoga margin 等价验证;
        // center/end 对齐写入但求解器跳过(下游以 translate 实现), 报告中计 unverifiableCorrections。
        child.layout = { ...(child.layout || {}), crossOffset: off };
        crossCorrected++;
      }
      if (crossCorrected > 0) {
        truthReport = verifyLayoutTruth({ tree: blueprintTree, floatings: floatingsBlueprint });
        truthReport.refinedContainers = truthRefinedContainers;
        truthReport.crossCorrected = crossCorrected;
      }
    }
  }

  // 6. 样式守恒门禁: 原 DSL 样式事实 vs 蓝图逐 id 比对 —— 几何(diffReport)与
  //    flex 真值(truthReport)之外的第三道闸, 抓"颜色/描边/旋转/透明度在链路上丢失"。
  const exemptIds = new Set(layoutResult.backgrounds.map((b) => b.id));
  const styleDiffReport = verifyStyleConservation(cleanNodes, [...blueprintTreeOut, ...floatingsBlueprint], styles || {}, exemptIds);

  return {
    canvas: scaleMeta ? { ...canvas, scale: scaleMeta } : canvas,
    stats: {
      totalOriginalNodes: nodes.length,
      cleanNodes: cleanNodes.length,
      topLevelContainers: blueprintTree.length,
      pageShell: pageShell ? pageShell.archetype : null,
      floatingsCount: layoutResult.floatings.length,
      backgroundsCount: layoutResult.backgrounds.length,
      semanticRenames,
    },
    backgrounds: layoutResult.backgrounds.map(b => ({
      id: b.id,
      name: b.name || undefined,
      // bounds 含 x/y(审计修复): 缺坐标则下游无法定位重建该背景层
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      fill: b.fill || b._color,
    })),
    componentGroups: detectSiblingComponentGroups([...blueprintTreeOut, ...floatingsBlueprint]),
    floatings: floatingsBlueprint,
    tree: blueprintTreeOut,
    pageShell,
    diffReport,
    truthReport,
    styleDiffReport,
    designTokens: extractDesignTokens({ tree: blueprintTree, floatings: floatingsBlueprint }, { includeAliases: false }),
  };
}


/**
 * 样式守恒回验 (verifyStyleConservation): 对每个 id, 原 DSL 中存在的样式事实
 * (颜色/渐变/位图/描边/旋转/不透明度/字号/字重/行高/字距/图标键)必须在蓝图中可达,
 * 否则记为丢失。几何守恒(autoHealingLayoutDiff)之外的样式维度门禁 —— 防止
 * "几何 PASS 但样式静默丢失"污染下游还原。
 *
 * @param {Array} originalNodes 清洗后扁平节点(含 layoutStyle/_color/text 等)
 * @param {Array} roots 蓝图根(tree + floatings)
 * @param {object} styles dsl.styles 引用表
 * @param {Set} exemptIds 不参与比对的 id(如背景层, 蓝图中单独输出)
 */
function verifyStyleConservation(originalNodes = [], roots = [], styles = {}, exemptIds = new Set()) {
  const origMap = new Map();
  for (const n of originalNodes) if (n && n.id) origMap.set(n.id, n);
  const bpMap = new Map();
  const walk = (n) => { if (!n || typeof n !== 'object' || !n.id || bpMap.has(n.id)) return; bpMap.set(n.id, n); for (const c of Array.isArray(n.children) ? n.children : []) walk(c); };
  roots.forEach(walk);

  // 树完整性: 原 id 未出现在蓝图(且非豁免) → 丢失
  const missingIds = [];
  for (const [id] of origMap) if (!bpMap.has(id) && !exemptIds.has(id)) missingIds.push(id);

  const offenders = [];
  let checkedFacts = 0;
  const expect = (id, field, ok) => { checkedFacts++; if (!ok) offenders.push({ id, field }); };
  for (const [id, orig] of origMap) {
    const bp = bpMap.get(id);
    if (!bp) continue; // 缺树已由 missingIds 记账; 树内节点才查字段
    const facts = extractExactStyles(orig, styles);
    if (facts.color != null) expect(id, 'color', bp.color === facts.color);
    if (facts.fill != null) {
      // crop(A3) 是从源父几何派生的显示框语义, 非设计稿样式事实, 不参与守恒比对
      const { crop: _crop, ...fillCore } = bp.fill || {};
      expect(id, 'fill', JSON.stringify(fillCore) === JSON.stringify(facts.fill));
    }
    if (facts.stroke != null) expect(id, 'stroke', JSON.stringify(bp.stroke) === JSON.stringify(facts.stroke));
    if (facts.rotation != null) expect(id, 'rotation', bp.rotation === facts.rotation);
    if (facts.opacity != null) expect(id, 'opacity', bp.opacity === facts.opacity);
    if (facts.fontSize != null) expect(id, 'fontSize', bp.fontSize === facts.fontSize);
    if (facts.fontWeight != null) expect(id, 'fontWeight', bp.fontWeight === facts.fontWeight);
    if (facts.lineHeight != null) expect(id, 'lineHeight', bp.lineHeight === facts.lineHeight);
    if (facts.letterSpacing != null) expect(id, 'letterSpacing', bp.letterSpacing === facts.letterSpacing);
    const rawSvg = orig.svgShortKey || orig.svgKey;
    if (rawSvg) expect(id, 'svgKey', bp.svgKey === rawSvg);
  }

  offenders.sort((a, b) => a.field.localeCompare(b.field) || String(a.id).localeCompare(String(b.id)));
  const lostByField = {};
  for (const o of offenders) lostByField[o.field] = (lostByField[o.field] || 0) + 1;
  const totalLost = offenders.length + missingIds.length;
  return {
    checkedFacts,
    lostFactCount: offenders.length,
    missingNodeCount: missingIds.length,
    lostByField,
    worstOffenders: offenders.slice(0, 10),
    missingIds: missingIds.slice(0, 10),
    verdict: totalLost === 0 ? 'PASS_STYLE_CONSERVED' : `FAIL_STYLE_LOST_${totalLost}`,
  };
}

/**
 * 5. 端侧自愈与 1:1 误差闭环门禁 (autoHealingLayoutDiff)
 * 在算法输出前，在内存中自发比对每个图元绝对坐标，最大误差 <= 0.04px
 */
function autoHealingLayoutDiff(originalNodes = [], reconstructedTree = []) {
  const originalMap = new Map();
  for (const n of originalNodes) {
    if (n && n.id) originalMap.set(n.id, n);
  }
  // 统一取几何: 兼容 {x,y,width,height} / {bounds:{x,y,...}} / {layoutStyle:{relativeX,...}} 三种形态
  const geom = (node) => {
    const b = node.bounds || {};
    const ls = node.layoutStyle || {};
    return {
      x: node.x ?? b.x ?? ls.relativeX ?? ls.x ?? 0,
      y: node.y ?? b.y ?? ls.relativeY ?? ls.y ?? 0,
      width: node.width ?? b.width ?? ls.width ?? 0,
      height: node.height ?? b.height ?? ls.height ?? 0,
    };
  };
  let maxDelta = 0;
  let checkedCount = 0;
  let pixelPerfectCount = 0;
  const offenders = [];
  // 扫描时携带祖先链, 用于定位责任容器与推断漂移原因
  function scan(node, ancestors) {
    if (node && node.id && originalMap.has(node.id)) {
      const orig = geom(originalMap.get(node.id));
      const rec = geom(node);
      const dx = Math.abs(rec.x - orig.x);
      const dy = Math.abs(rec.y - orig.y);
      const dw = Math.abs(rec.width - orig.width);
      const dh = Math.abs(rec.height - orig.height);
      const delta = Math.max(dx, dy, dw, dh);
      if (delta > maxDelta) maxDelta = delta;
      checkedCount++;
      if (delta <= 0.04) pixelPerfectCount++;
      else {
        // 原因标注: 主导漂移维度 + 最近 flex 祖先容器(回验降级的责任方)
        const drift = dx + dy >= dw + dh
          ? (dy > dx ? 'position-y' : 'position-x')
          : (dh > dw ? 'size-height' : 'size-width');
        const flexAncestor = [...ancestors].reverse().find((a) => {
          const ly = a.layout || {};
          return ly.role === 'row' || ly.role === 'column' || ly.position === 'flex';
        });
        offenders.push({
          id: node.id,
          name: node.name || '',
          delta: round1(delta),
          drift,
          reason: drift.startsWith('position')
            ? 'flex 对齐/间距推断导致位置漂移'
            : 'sizing/裁剪推断导致尺寸漂移',
          responsibleContainer: flexAncestor ? { id: flexAncestor.id, name: flexAncestor.name || '' } : null,
        });
      }
    }
    if (node && Array.isArray(node.children)) {
      for (const child of node.children) scan(child, [...ancestors, node]);
    }
  }
  for (const root of reconstructedTree) scan(root, []);
  offenders.sort((a, b) => b.delta - a.delta);
  const pixelPerfectRatio = checkedCount > 0 ? round1(pixelPerfectCount / checkedCount) : 1;
  return {
    checkedCount,
    pixelPerfectCount,
    pixelPerfectRatio,
    maxDelta: round1(maxDelta),
    isPixelPerfect: maxDelta <= 0.04,
    isHealed: maxDelta <= 2,
    worstOffenders: offenders.slice(0, 10),
    offenderCount: offenders.length,
    // 上限截断防巨页产物膨胀(>100 时以 offenderCount 为准); 降级逻辑容忍截断
    allOffenderIds: offenders.slice(0, 100).map((o) => o.id),
    verdict: maxDelta <= 0.04 ? "PASS_PIXEL_PERFECT (100% 1:1 零失真)" : (maxDelta <= 2 ? "PASS_WITH_TOLERANCE (<=2px)" : "FAIL_OVER_TOLERANCE (>2px, 需降级 absolute)"),
  };
}
export { inferLayout, autoHealingLayoutDiff, generateCodeBlueprint, sanitizeDslNodes, parseNeutralFill, verifyStyleConservation, mode, round1, simulateFlex, clusterByAxis, inferGridPattern, inferStaggeredDeck, isFloatingCapsule, inferViewportMetadata, extractExactStyles, reverseInferSemanticLayout };
