// visual-diff.ts - 视觉对比内核
// 两层指标, 对应 Stanford Design2Code (arXiv:2403.03163) 的量化评估思路:
// 1) 像素层: pixelmatch 逐像素 diff(抗锯齿容忍), 输出差异率与差异蒙版
// 2) 块级层: 文本块匹配 -> Sørensen-Dice 字符相似度配对 ->
//    Block-Match 面积命中率 / 位置相似度 / 颜色相似度
//
// 块级层不依赖 OCR: 渲染侧的块清单由渲染器直接导出(Flutter golden 渲染树里
// 收集 RenderParagraph), 设计侧清单来自蓝图 bounds —— 双方都是确定性的。
// 与技术栈无关: 任何能产出 {png, textBlocks[]} 的渲染器(Web 截图/Flutter golden/
// 原生快照)都接同一个内核。

import { PNG } from "pngjs"
import pixelmatch from "pixelmatch"

const round1 = (n) => Math.round((n || 0) * 100) / 100

/** 解码 PNG buffer -> {width, height, data(RGBA)} */
export function decodePng(buf) {
  return PNG.sync.read(buf)
}

/**
 * 像素级对比 (comparePng)
 * @returns {{width,height,diffPixels,diffRatio,diffPng:Buffer}}
 */
export function comparePng(bufA, bufB, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.1
  const a = decodePng(bufA)
  const b = decodePng(bufB)
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const diff = new PNG({ width, height })
  const diffPixels = pixelmatch(
    cropTo(a, width, height), cropTo(b, width, height),
    diff.data, width, height,
    { threshold, includeAA: true }
  )
  return {
    width,
    height,
    diffPixels,
    diffRatio: round1(diffPixels / (width * height)),
    diffPng: PNG.sync.write(diff),
  }
}

function cropTo(png, width, height) {
  if (png.width === width && png.height === height) return png.data
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    png.data.copy(out, y * width * 4, y * png.width * 4, y * png.width * 4 + width * 4)
  }
  return out
}

/**
 * 差异区域聚类 (diffRegions): 像素差异 → 空间区域 → 蓝图节点候选。
 * 修复定位段(闭环第六段): 验证失败后给 LLM 的不是数字而是"哪里不对、疑似哪个节点"。
 *
 * 逐像素通道差阈值标记(粗定位, 与 pixelmatch 的感知指标互补) → 网格桶计数 →
 * 8 邻域 BFS 合并为区域 → 按像素量降序取 top N → 映射 bounds 相交的蓝图叶子节点。
 *
 * @param {Buffer} bufA 真值图
 * @param {Buffer} bufB 渲染图
 * @param {object} [opts] threshold: 通道差阈值(默认24); grid: 聚类网格px(默认24);
 *   minPixels: 区域最小像素(默认48); top: 最多区域数(默认5);
 *   nodes: 蓝图叶子数组 [{id,name,text,bounds}] 用于候选映射(可选)
 * @returns {{width,height,markedPixels,markedRatio,clusterCount,regions:Array}}
 */
export function diffRegions(bufA, bufB, opts = {}) {
  const threshold = opts.threshold ?? 24
  const grid = opts.grid ?? 24
  const minPixels = opts.minPixels ?? 48
  const top = opts.top ?? 5
  const nodes = Array.isArray(opts.nodes) ? opts.nodes : null

  const a = decodePng(bufA)
  const b = decodePng(bufB)
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)

  const buckets = new Map() // "gx,gy" -> 标记像素数
  let totalMarked = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * a.width + x) * 4
      const j = (y * b.width + x) * 4
      const d = Math.max(
        Math.abs(a.data[i] - b.data[j]),
        Math.abs(a.data[i + 1] - b.data[j + 1]),
        Math.abs(a.data[i + 2] - b.data[j + 2]),
      )
      if (d > threshold) {
        totalMarked++
        const key = Math.floor(x / grid) + ',' + Math.floor(y / grid)
        buckets.set(key, (buckets.get(key) || 0) + 1)
      }
    }
  }

  // 8 邻域 BFS 合并相邻桶为区域
  const clusters = []
  const seen = new Set()
  for (const key of buckets.keys()) {
    if (seen.has(key)) continue
    let pixels = 0
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
    const queue = [key]
    seen.add(key)
    while (queue.length) {
      const cur = queue.pop()
      const [gx, gy] = cur.split(',').map(Number)
      pixels += buckets.get(cur) || 0
      minX = Math.min(minX, gx * grid)
      minY = Math.min(minY, gy * grid)
      maxX = Math.max(maxX, (gx + 1) * grid)
      maxY = Math.max(maxY, (gy + 1) * grid)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nk = (gx + dx) + ',' + (gy + dy)
          if (buckets.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(nk) }
        }
      }
    }
    if (pixels >= minPixels) {
      clusters.push({ x: minX, y: minY, width: maxX - minX, height: maxY - minY, pixels })
    }
  }
  clusters.sort((p, q) => q.pixels - p.pixels)

  const regions = clusters.slice(0, top).map((c) => {
    if (!nodes) return c
    const interArea = (n) => {
      const b = n.bounds
      const w = Math.min(b.x + b.width, c.x + c.width) - Math.max(b.x, c.x)
      const h = Math.min(b.y + b.height, c.y + c.height) - Math.max(b.y, c.y)
      return w > 0 && h > 0 ? w * h : 0
    }
    const candidates = nodes
      .filter((n) => n.bounds && interArea(n) > 0)
      .sort((m, n) => interArea(n) - interArea(m))
      .slice(0, 3)
      .map((n) => ({ id: n.id, name: n.name || '', text: typeof n.text === 'string' ? String(n.text).slice(0, 20) : (n.text ?? null) }))
    return { ...c, candidates }
  })

  return {
    width,
    height,
    markedPixels: totalMarked,
    markedRatio: round1(totalMarked / (width * height)),
    clusterCount: clusters.length,
    regions,
  }
}

/** Sørensen-Dice 系数(字符 bigram): D2C 的文本相似度定义 */
export function textSimilarity(s1, s2) {
  s1 = String(s1 ?? "").replace(/\s+/g, "")
  s2 = String(s2 ?? "").replace(/\s+/g, "")
  if (!s1 && !s2) return 1
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const g1 = grams(s1), g2 = grams(s2)
  let inter = 0
  for (const [g, c] of g1) if (g2.has(g)) inter += Math.min(c, g2.get(g))
  return (2 * inter) / ([...g1.values()].reduce((a, b) => a + b, 0) + [...g2.values()].reduce((a, b) => a + b, 0)) || (s1.length === 1 && s2.length === 1 ? (s1 === s2 ? 1 : 0) : 0)
}

function regionAvgColor(img, width, blk) {
  // 采样块区域的平均 RGB(步长采样防大块过慢)
  const x0 = Math.max(0, Math.round(blk.x)), y0 = Math.max(0, Math.round(blk.y))
  const x1 = Math.min(width, Math.round(blk.x + (blk.width || 0)))
  const y1 = Math.min(img.height, Math.round(blk.y + (blk.height || 0)))
  let r = 0, g = 0, b = 0, n = 0
  const step = Math.max(1, Math.floor((x1 - x0) / 8))
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * 4
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++
    }
  }
  if (!n) return null
  return [r / n, g / n, b / n]
}

function colorSim(c1, c2) {
  if (!c1 || !c2) return null
  const d = Math.sqrt((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2) / Math.sqrt(3 * 255 * 255)
  return round1(1 - d)
}

/**
 * 块级指标 (blockMetrics) —— Design2Code 四指标的确定性适配版
 *
 * @param {Array<{text,x,y,width,height}>} designBlocks 设计侧块清单(蓝图导出)
 * @param {Array<{text,x,y,width,height}>} renderBlocks 渲染侧块清单(渲染器导出)
 * @param {object} [ctx] {designPng, renderPng} 解码后的像素图(可选, 启用颜色相似度)
 * @returns {{blockMatchRate, matchedPairs, positionSimilarity, colorSimilarity, unmatchedDesign, unmatchedRender}}
 */
export function blockMetrics(designBlocks, renderBlocks, ctx = {}) {
  const W = ctx.canvasWidth || Math.max(...designBlocks.map((b) => b.x + b.width), 1)
  const H = ctx.canvasHeight || Math.max(...designBlocks.map((b) => b.y + b.height), 1)

  // 贪心全局配对: 按 文本相似度 desc -> 中心距 asc
  const pairs = []
  for (const d of designBlocks) {
    for (const r of renderBlocks) {
      const ts = textSimilarity(d.text, r.text)
      if (ts <= 0.34) continue // D2C 同款低相似门槛
      const dc = Math.hypot((d.x + d.width / 2) - (r.x + r.width / 2), (d.y + d.height / 2) - (r.y + r.height / 2))
      pairs.push({ d, r, ts, dc })
    }
  }
  pairs.sort((a, b) => (b.ts - a.ts) || (a.dc - b.dc))
  const usedD = new Set(), usedR = new Set()
  const matched = []
  for (const p of pairs) {
    if (usedD.has(p.d) || usedR.has(p.r)) continue
    usedD.add(p.d); usedR.add(p.r)
    const posSim = round1(Math.max(0, 1 - Math.max(Math.abs(p.d.x - p.r.x) / W, Math.abs(p.d.y - p.r.y) / H)))
    matched.push({ design: p.d.text, render: p.r.text, textSim: round1(p.ts), posSim, _d: p.d, _r: p.r })
  }

  // Block-Match: 匹配面积的 precision/recall 调和均值(同时惩罚漏检与幻觉块)。
  // 面积直接取配对双方块, 不按文本回查(重名文本会错配)。
  const areaOf = (b) => Math.max(0, b.width || 0) * Math.max(0, b.height || 0)
  const designArea = designBlocks.reduce((s, b) => s + areaOf(b), 0)
  const renderArea = renderBlocks.reduce((s, b) => s + areaOf(b), 0)
  const matchedDesignArea = matched.reduce((s, m) => s + areaOf(m._d), 0)
  const matchedRenderArea = matched.reduce((s, m) => s + areaOf(m._r), 0)
  const recallP = designArea > 0 ? matchedDesignArea / designArea : 1
  const precisionP = renderArea > 0 ? matchedRenderArea / renderArea : 1
  const blockMatchRate = round1(recallP + precisionP > 0 ? (2 * recallP * precisionP) / (recallP + precisionP) : 1)

  const positionSimilarity = matched.length ? round1(matched.reduce((s, m) => s + m.posSim, 0) / matched.length) : null

  let colorSimilarity = null
  if (ctx.designImg && ctx.renderImg) {
    const sims = []
    for (const m of matched) {
      const cs = colorSim(regionAvgColor(ctx.designImg, ctx.designImg.width, m._d), regionAvgColor(ctx.renderImg, ctx.renderImg.width, m._r))
      if (cs != null) sims.push(cs)
    }
    if (sims.length) colorSimilarity = round1(sims.reduce((a, b) => a + b, 0) / sims.length)
  }

  return {
    blockMatchRate,
    matchedPairs: matched.length,
    positionSimilarity,
    colorSimilarity,
    avgTextSimilarity: matched.length ? round1(matched.reduce((s, m) => s + m.textSim, 0) / matched.length) : null,
    unmatchedDesign: designBlocks.filter((b) => !usedD.has(b)).map((b) => b.text),
    unmatchedRender: renderBlocks.filter((b) => !usedR.has(b)).map((b) => b.text),
    detail: matched.map(({ _d, _r, ...rest }) => rest),
  }
}
