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

// @ts-ignore
import { PNG } from "pngjs"
import pixelmatch from "pixelmatch"
import { round2 } from "./numeric.ts"

// 位置相似度封顶尺度(px): 偏移达此值记 0 分。与画布尺寸解耦 —— 旧式"除以画布宽高"
// 在长页上会稀释绝对偏差(500px 错位仍≈0.97), 跨稿不可比(审计修订)。
const POS_SIM_CAP_PX = 64
/** 解码 PNG buffer -> {width, height, data(RGBA)}（带明确错误信息，防上游截屏/IO 损坏静默透传） */
export function decodePng(buf: any) {
  try { return PNG.sync.read(buf) } catch(e){
    throw new Error(`decodePng: PNG 解码失败（文件损坏或非 PNG）: ${String((e as Error).message).slice(0,120)}`)
  }
}

/**
 * 像素级对比 (comparePng)
 * @returns {{width,height,diffPixels,diffRatio,diffPng:Buffer}}
 */
export function comparePng(bufA: any, bufB: any, opts: Record<string, any> = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.1
  const a = decodePng(bufA)
  const b = decodePng(bufB)
  // 尺寸守卫(审计 P0 修复): 尺寸不一致 = 采样环境失配(不同 viewport/scale/页高),
  // 静默裁剪到公共区会把"渲染多出/缺失一整屏"洗成 diffRatio=0(已有运行时实证)。
  // 归一职责在调用方(同一 viewport 截图); 确需裁剪公共区的旧行为请显式传 allowCrop:true。
  if ((a.width !== b.width || a.height !== b.height) && !opts.allowCrop) {
    throw new Error(`comparePng: 两图尺寸不一致 A=${a.width}x${a.height} B=${b.width}x${b.height} — 先统一截图环境再对比; 如确要只比公共区传 opts.allowCrop=true`)
  }
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
    diffRatio: round2(diffPixels / (width * height)),
    diffPng: PNG.sync.write(diff),
  }
}

function cropTo(png: any, width: any, height: any) {
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
 *   nodes: 蓝图叶子数组 [{id,name,text,bounds}] 用于候选映射(可选);
 *   allowCrop: 尺寸不一致时允许裁剪到公共区(默认 false, 硬失败防止静默漏检)
 * @returns {{width,height,markedPixels,markedRatio,clusterCount,regions:Array}}
 */
export function diffRegions(bufA: any, bufB: any, opts: Record<string, any> = {}) {
  const threshold = opts.threshold ?? 24
  const grid = opts.grid ?? 24
  const minPixels = opts.minPixels ?? 48
  const top = opts.top ?? 5
  const nodes = Array.isArray(opts.nodes) ? opts.nodes : null

  const a = decodePng(bufA)
  const b = decodePng(bufB)
  // 同 comparePng 的尺寸守卫: 区域聚类建立在逐像素对齐之上, 尺寸失配时结果无意义
  if ((a.width !== b.width || a.height !== b.height) && !opts.allowCrop) {
    throw new Error(`diffRegions: 两图尺寸不一致 A=${a.width}x${a.height} B=${b.width}x${b.height} — 先统一截图环境再定位; 如确要只比公共区传 opts.allowCrop=true`)
  }
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
  clusters.sort((p: any, q: any) => q.pixels - p.pixels)

  const regions = clusters.slice(0, top).map((c: any) => {
    if (!nodes) return c
    const selfArea = (b: any) => Math.max(b.width * b.height, 1)
    const interArea = (n: any) => {
      const b = n.bounds
      const w = Math.min(b.x + b.width, c.x + c.width) - Math.max(b.x, c.x)
      const h = Math.min(b.y + b.height, c.y + c.height) - Math.max(b.y, c.y)
      return w > 0 && h > 0 ? w * h : 0
    }
    // 候选评分 = 相交面积 × 覆盖率(交集/自身面积): 小节点与差异区完全重叠得分高,
    // 大背景/蒙版节点仅局部重叠被降权 —— 否则候选恒被大节点霸占
    const score = (n: any) => {
      const ia = interArea(n)
      return ia > 0 ? ia * (ia / selfArea(n.bounds)) : 0
    }
    const candidates = nodes
      .filter((n: any) => n.bounds && interArea(n) > 0)
      .sort((m: any, n: any) => score(n) - score(m))
      .slice(0, 3)
      .map((n: any) => ({ id: n.id, name: n.name || '', text: typeof n.text === 'string' ? String(n.text).slice(0, 20) : (n.text ?? null) }))
    return { ...c, candidates }
  })

  return {
    width,
    height,
    markedPixels: totalMarked,
    markedRatio: round2(totalMarked / (width * height)),
    clusterCount: clusters.length,
    regions,
  }
}

/** Sørensen-Dice 系数(字符 bigram): D2C 的文本相似度定义 */
export function textSimilarity(s1: any, s2: any) {
  s1 = String(s1 ?? "").toLowerCase().replace(/\s+/g, "")
  s2 = String(s2 ?? "").toLowerCase().replace(/\s+/g, "")
  if (!s1 && !s2) return 1
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  const grams = (s: any) => {
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
  return (2 * inter) / ([...g1.values()].reduce((a: any, b: any) => a + b, 0) + [...g2.values()].reduce((a: any, b: any) => a + b, 0)) || (s1.length === 1 && s2.length === 1 ? (s1 === s2 ? 1 : 0) : 0)
}

function regionAvgColor(img: any, width: any, blk: any) {
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

function colorSim(c1: any, c2: any) {
  if (!c1 || !c2) return null
  const d = Math.sqrt((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2) / Math.sqrt(3 * 255 * 255)
  return round2(1 - d)
}

/**
 * 块级指标 (blockMetrics) —— Design2Code 四指标的确定性适配版
 *
 * @param {Array<{text,x,y,width,height}>} designBlocks 设计侧块清单(蓝图导出)
 * @param {Array<{text,x,y,width,height}>} renderBlocks 渲染侧块清单(渲染器导出)
 * @param {object} [ctx] {designImg, renderImg} 解码后的像素图(可选, 启用颜色相似度);
 *   canvasWidth/canvasHeight 已废弃(位置相似度改为尺寸无关的 px 制, 入参仅为兼容保留)
 * @returns {{blockMatchRate, matchedPairs, positionSimilarity, colorSimilarity, unmatchedDesign, unmatchedRender}}
 */
export function blockMetrics(designBlocks: any, renderBlocks: any, ctx: Record<string, any> = {}) {
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
  pairs.sort((a: any, b: any) => (b.ts - a.ts) || (a.dc - b.dc))
  const usedD = new Set(), usedR = new Set()
  const matched = []
  for (const p of pairs) {
    if (usedD.has(p.d) || usedR.has(p.r)) continue
    usedD.add(p.d); usedR.add(p.r)
    // 位置相似度: 绝对 px 偏移相对 POS_SIM_CAP_PX 线性衰减, 与画布尺寸彻底解耦 ——
    // 长页不再把大错位稀释成高分, 小卡片与整页同一把尺(POS_SIM_CAP_PX 定义见文件头)
    const offPx = Math.max(Math.abs(p.d.x - p.r.x), Math.abs(p.d.y - p.r.y))
    const posSim = round2(Math.max(0, 1 - offPx / POS_SIM_CAP_PX))
    matched.push({ design: p.d.text, render: p.r.text, textSim: round2(p.ts), posSim, _d: p.d, _r: p.r })
  }

  // Block-Match: 匹配面积的 precision/recall 调和均值(同时惩罚漏检与幻觉块)。
  // 面积直接取配对双方块, 不按文本回查(重名文本会错配)。
  const areaOf = (b: any) => Math.max(0, b.width || 0) * Math.max(0, b.height || 0)
  const designArea = designBlocks.reduce((s: any, b: any) => s + areaOf(b), 0)
  const renderArea = renderBlocks.reduce((s: any, b: any) => s + areaOf(b), 0)
  const matchedDesignArea = matched.reduce((s: any, m: any) => s + areaOf(m._d), 0)
  const matchedRenderArea = matched.reduce((s: any, m: any) => s + areaOf(m._r), 0)
  const recallP = designArea > 0 ? matchedDesignArea / designArea : 1
  const precisionP = renderArea > 0 ? matchedRenderArea / renderArea : 1
  // 无配对 → 块匹配率为 0(设计有文本块但渲染什么都没匹配上时, 不得判为满分)
  const blockMatchRate = matched.length === 0 ? 0 : round2((2 * recallP * precisionP) / (recallP + precisionP))

  const positionSimilarity = matched.length ? round2(matched.reduce((s: any, m: any) => s + m.posSim, 0) / matched.length) : null

  let colorSimilarity = null
  if (ctx.designImg && ctx.renderImg) {
    const sims = []
    for (const m of matched) {
      const cs = colorSim(regionAvgColor(ctx.designImg, ctx.designImg.width, m._d), regionAvgColor(ctx.renderImg, ctx.renderImg.width, m._r))
      if (cs != null) sims.push(cs)
    }
    if (sims.length) colorSimilarity = round2(sims.reduce((a: any, b: any) => a + b, 0) / sims.length)
  }

  return {
    blockMatchRate,
    matchedPairs: matched.length,
    positionSimilarity,
    colorSimilarity,
    avgTextSimilarity: matched.length ? round2(matched.reduce((s: any, m: any) => s + m.textSim, 0) / matched.length) : null,
    unmatchedDesign: designBlocks.filter((b: any) => !usedD.has(b)).map((b: any) => b.text),
    unmatchedRender: renderBlocks.filter((b: any) => !usedR.has(b)).map((b: any) => b.text),
    detail: matched.map(({ _d, _r, ...rest }) => rest),
  }
}

/**
 * 差异修正指令 (diffToCorrections): 把视觉 diff 区域翻译为 LLM 可执行的核对任务清单。
 * 像素差不等于属性差(不猜测 "+4px" 量级), 只负责定位: 差在哪 / 关联哪些蓝图节点 / 去核对什么;
 * 数值真值始终在蓝图, 修正以 blueprintRegion 下钻的子树为准。
 *
 * @param {object} bp generateCodeBlueprint 输出(用于区域→节点关联与指令生成)
 * @param {object} diff diffRegions 输出 {regions:[{x,y,width,height,pixels,candidates?}], markedRatio}
 * @returns {{summary:string, corrections:string[]}|null}
 */
export function diffToCorrections(bp: any, diff: any) {
  if (!diff || !Array.isArray(diff.regions)) return null
  const byId = new Map()
  const idx = (n: any) => {
    if (n && n.id) byId.set(n.id, n)
    for (const c of (n && n.children) || []) idx(c)
  }
  for (const r of [...(bp?.tree || []), ...(bp?.floatings || [])]) idx(r)
  const corrections = diff.regions.map((r: any, i: any) => {
    const cands = r.candidates || []
    const nodes = cands.map((c: any) => byId.get(c.id)).filter(Boolean)
    // severity 定级(审计修订): 有画布信息时主判据为"标记像素/画布面积"占比 ——
    // 与画布尺寸解耦: 长页上万级噪声像素不再误升 major, 大区域错乱也不因画布大而漏报;
    // 阈值按 375x812 手机稿标定(major≈914px/minor≈244px), 与旧绝对阈值在该基准下等价;
    // 缺画布信息(极端调用方)回退旧绝对像素规则。
    const cw = bp?.canvas?.width, chh = bp?.canvas?.height
    const frac = cw > 0 && chh > 0 ? r.pixels / (cw * chh) : null
    const severity = frac == null ? (r.pixels > 800 ? 'major' : r.pixels > 200 ? 'minor' : 'noise')
      : frac >= 0.003 ? 'major' : frac >= 0.0008 ? 'minor' : 'noise'
    const head = `#${i + 1} [${severity}] 区域(${r.x},${r.y} ${r.width}x${r.height}) 标记像素 ${r.pixels}`
    if (nodes.length) {
      const desc = nodes
        .map((n: any) => `${n.id}(${n.name || ''}${typeof n.text === 'string' && n.text ? ` "${String(n.text).slice(0, 12)}"` : ''})`)
        .join(', ')
      return `${head} | 关联节点: ${desc} | 用 blueprintRegion(bp,{ids:[${nodes.map((n: any) => JSON.stringify(n.id)).join(',')}]}).nodes[0] 下钻, 以蓝图 bounds/layout/样式数值逐项核对渲染实现`
    }
    return `${head} | 无蓝图节点命中 — 疑似元素缺失或越界内容, 对照 checklist 检查遗漏项`
  })
  return {
    summary: `${corrections.length} 处差异区域 | 标记像素占比 ${diff.markedRatio}`,
    corrections,
  }
}

/**
 * 几何参考快照 (renderGeometrySnapshot): 从蓝图确定性光栅化 truth 参考图(d2c 第十四节 Reference Snapshot)。
 *
 * 定位与局限(诚实边界):
 *  - 能检出: 位置/尺寸/层级/颜色块级差异(geometry+color 级)
 *  - 不能检出: 字形/抗锯齿/阴影羽化等渲染细节级差异
 *  - 文本画为"墨迹条"(宽=measured.singleLineWidth, 高≈fontSize), 非真实字形
 *  - backgrounds 仅绘制纯色 hex 底; 渐变/位图背景跳过(留默认底色)
 * z 序 = 数组序自下而上(与蓝图消费约定一致)。
 *
 * @param {object} bp generateCodeBlueprint 输出
 * @param {object} [opts] {scale=1, background='#FFFFFF'}
 * @returns {{png:Buffer, width:number, height:number}}
 */
export function renderGeometrySnapshot(bp: any, opts: Record<string, any> = {}) {
  const scale = opts.scale ?? 1
  const W = Math.round((bp?.canvas?.width ?? 375) * scale)
  const H = Math.round((bp?.canvas?.height ?? 812) * scale)
  const png = new PNG({ width: W, height: H })
  const hex2rgb = (s: any) => {
    const m = String(s || '').trim().match(/^#([0-9a-fA-F]{3,8})$/)
    if (!m) return null
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((c: any) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
    return { r, g, b }
  }
  // 底色
  const bg = hex2rgb(opts.background ?? '#FFFFFF') ?? { r: 255, g: 255, b: 255 }
  for (let i = 0; i < W * H; i++) {
    png.data[i * 4] = bg.r; png.data[i * 4 + 1] = bg.g; png.data[i * 4 + 2] = bg.b; png.data[i * 4 + 3] = 255
  }
  const fillRect = (x0: any, y0: any, w0: any, h0: any, rgb: any, alpha = 1) => {
    const x1 = Math.max(0, Math.round(x0 * scale)), y1 = Math.max(0, Math.round(y0 * scale))
    const x2 = Math.min(W, Math.ceil((x0 + w0) * scale)), y2 = Math.min(H, Math.ceil((y0 + h0) * scale))
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const i = (y * W + x) * 4
        png.data[i] = Math.round(png.data[i] * (1 - alpha) + rgb.r * alpha)
        png.data[i + 1] = Math.round(png.data[i + 1] * (1 - alpha) + rgb.g * alpha)
        png.data[i + 2] = Math.round(png.data[i + 2] * (1 - alpha) + rgb.b * alpha)
        png.data[i + 3] = 255
      }
    }
  }
  // 背景层底色(审计修复): backgrounds 在蓝图中单独输出、不在 tree 里,
  // 不绘制它们会让深色底稿的 truth 快照恒白, 对照浏览器截图产生整页伪差。
  // 仅支持纯色 hex; 渐变/位图背景无法用单色表达, 跳过(维持下方诚实边界声明)。
  for (const bg of Array.isArray(bp?.backgrounds) ? bp.backgrounds : []) {
    const rgb = hex2rgb(bg.fill) ?? hex2rgb(bg.color)
    if (!rgb || !bg.bounds) continue
    const bx = bg.bounds.x ?? 0
    const by = bg.bounds.y ?? 0
    fillRect(bx, by, bg.bounds.width ?? (W - bx), bg.bounds.height ?? (H - by), rgb)
  }
  const walk = (n: any) => {
    if (!n || typeof n !== 'object' || !n.bounds) return
    const b = n.bounds
    const isText = n.type === 'TEXT' || (typeof n.text === 'string' && n.text !== '')
    if (isText) {
      // 文本墨迹条: 宽=min(实测宽,bounds宽), 高≈fontSize 居中于 bounds
      const rgb = hex2rgb(n.color) ?? { r: 40, g: 40, b: 40 }
      const fs = n.fontSize ?? Math.round(b.height * 0.72)
      const inkW = Math.min(n.measured?.singleLineWidth ?? b.width, b.width)
      const inkH = Math.min(fs, b.height)
      fillRect(b.x, b.y + (b.height - inkH) / 2, inkW, inkH, rgb, 0.85)
    } else {
      let col = n.color ?? null
      if (n.fill?.type === 'solid') col = n.fill.value ?? col
      else if (n.fill?.type === 'gradient') col = n.fill.stops?.[0]?.color ?? col
      else if (n.fill?.type === 'image') col = col ?? '#CFCFCF' // 位图占位灰
      const rgb = hex2rgb(col)
      if (rgb && !n.clipShape) fillRect(b.x, b.y, b.width, b.height, rgb)
    }
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c)
  }
  for (const r of [...(bp?.tree || []), ...(bp?.floatings || [])]) walk(r)
  return { png: PNG.sync.write(png), width: W, height: H }
}
