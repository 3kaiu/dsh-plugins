// visual-loop-shared — run-visual-loop / run-visual-loop-batch 的公共核(2026-08-30 去重)
//
// 两脚本原各自持有几乎相同的 展平器/spec 收集器/flutter 失败处理/对比尾核,
// 且已实际漂移: batch 版收集器缺 svg 资源表支持。本模块单点维护。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { comparePng, blockMetrics, decodePng } from '../packages/ui-restore/dist/index.js';

/**
 * layoutStyle 树 → 绝对坐标扁平节点(generateCodeBlueprint 消费形态)。
 * origin (ox, oy): section 原点; relativeX/Y 同步改写为绝对值(单一语义)。
 */
export function flattenNodes(nodes, ox = 0, oy = 0) {
  const flat = [];
  const emit = (n, x0, y0) => {
    const ls = n.layoutStyle || {};
    flat.push({ ...n, x: (ls.relativeX ?? 0) + x0, y: (ls.relativeY ?? 0) + y0, width: ls.width ?? 0, height: ls.height ?? 0, children: undefined,
      layoutStyle: { ...(n.layoutStyle || {}), relativeX: (ls.relativeX ?? 0) + x0, relativeY: (ls.relativeY ?? 0) + y0 } });
    (n.children || []).forEach(c => emit(c, (ls.relativeX ?? 0) + x0, (ls.relativeY ?? 0) + y0));
  };
  nodes.forEach(n => emit(n, ox, oy));
  return flat;
}

/**
 * 蓝图树 → truth spec items(文本/图标/色块; 矢量资源表命中时输出 SVG 项并
 * 跳过同样命中的嵌套子项, 防父 svg 与子元素叠加重影)。
 */
export function collectSpecItems(tree, floatings = [], svgAssets = null) {
  const items = [];
  const collect = (n) => {
    if (!n || typeof n !== 'object') return;
    const hasText = (n.text || '').length > 0 || n.type === 'TEXT';
    const b = n.bounds || {};
    if (svgAssets && svgAssets[n.id]) {
      items.push({ type: 'SVG', id: n.id, bounds: { ...b } });
      for (const c of (n.children || [])) {
        if (svgAssets[c.id]) continue;
        collect(c);
      }
      return;
    }
    if (hasText && n.text) {
      items.push({ type: 'TEXT', text: String(n.text), bounds: { ...b }, color: n.color, fontSize: n.fontSize, fontWeight: n.fontWeight, lineHeight: n.lineHeight, letterSpacing: n.letterSpacing });
    } else if (n.svgKey) {
      items.push({ type: 'ICON', svgKey: n.svgKey, bounds: { ...b } });
    } else if (n.color && !hasText) {
      items.push({ type: 'BOX', bounds: { ...b }, color: n.color, layout: { borderRadius: n.layout?.borderRadius } });
    }
    (n.children || []).forEach(collect);
  };
  [...(tree || []), ...(floatings || [])].forEach(collect);
  return items;
}

/** flutter golden 渲染: status===null(超时/信号)必须显性失败, 不得静默当成功 */
export function runFlutterGolden(harnessDir, dartTest, env, timeoutMs, label = 'flutter test') {
  const r = spawnSync('flutter', ['test', dartTest, '--update-goldens'], { cwd: harnessDir, encoding: 'utf8', env, timeout: timeoutMs });
  if (r.status !== 0 || r.status === null) {
    const sig = r.signal ? ` (signal ${r.signal})` : (r.error ? ` (${r.error.message})` : '');
    console.error(`${label} failed${sig}:\n${r.stdout?.slice(-2000)}\n${r.stderr?.slice(-2000)}`);
    process.exit(1);
  }
}

/** 像素层 + 块级层对比, 写 diff 蒙版, 返回指标 */
export function comparePair({ pngTruth, pngFlex, manifestTruth, manifestFlex, canvas, diffOut }) {
  const pixel = comparePng(pngTruth, pngFlex);
  if (diffOut) fs.writeFileSync(diffOut, pixel.diffPng);
  const blocks = blockMetrics(manifestTruth, manifestFlex, {
    designImg: decodePng(pngTruth),
    renderImg: decodePng(pngFlex),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });
  return { pixel, blocks };
}

export { path, fs };
