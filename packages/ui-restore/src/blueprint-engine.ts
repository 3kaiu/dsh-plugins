// blueprint-engine — 蓝图构建层(reverseInfer → sanitize → generate → 自愈/守恒验证)
//
// 分层切割(doc19 §2.2 批3): 纯引擎(几何推断/样式解析)已归一 @3kaiu/dsh-plugin-kit;
// 本模块保留蓝图构建层 —— 它依赖 describe/verify 增强层(design-tokens/text-metrics/
// yoga-truth/scale, 即 opentype.js/yoga-layout 两个重运行时依赖), 刻意不进 kit,
// 避免 bundle kit 的每个插件(lAYOUT-INFER/ura)被拖入重依赖。
// 引擎函数一律自 kit 单源导入, 本文件不再持有任何引擎副本。

import { TOL, MACHINE_NAME_RE, semanticNodeName, mode, round1, inferLayout, simulateFlex, clusterByAxis, inferGridPattern, inferStaggeredDeck, isFloatingCapsule, inferViewportMetadata, extractExactStyles, parseNeutralFill, richTextRuns, CONTAINER_ABSORB_RATIO } from '@3kaiu/dsh-plugin-kit'
import { detectSiblingComponentGroups } from '@3kaiu/dsh-plugin-kit'
import { extractDesignTokens } from './design-tokens.ts'
import { measurerInfo, predictTextLayout } from './text-metrics.ts'
import { verifyLayoutTruth } from './yoga-truth.ts'
import { resolveDesignScale, applyDesignScale } from './scale.ts'

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

export { reverseInferSemanticLayout, sanitizeDslNodes, generateCodeBlueprint, verifyStyleConservation, autoHealingLayoutDiff };
