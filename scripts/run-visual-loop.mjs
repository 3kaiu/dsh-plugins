// 视觉闭环驱动: 蓝图 -> Flutter 双模式渲染(truth/flex) -> 像素+块级指标对比
//
// 用法: node scripts/run-visual-loop.mjs [设计稿json路径]
//   默认使用 output/study-408-8738-raw.json
// 产物目录: visual-loop/build/
//   spec_truth.json / spec_flex.json   两份渲染 spec
//   golden_truth.png / golden_flex.png golden 渲染(首次 --update-goldens 自动写入)
//   manifest_truth.json / manifest_flex.json  真实渲染文本块清单
//   diff.png                            pixelmatch 差异蒙版
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateCodeBlueprint, initTextMetrics, comparePng, blockMetrics, decodePng } from '../packages/ui-restore/dist/index.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(rootDir, 'visual-loop', 'build');
const harnessDir = path.join(rootDir, 'visual-loop', 'flutter_harness');
fs.mkdirSync(buildDir, { recursive: true });

const designPath = process.argv[2] || path.join(rootDir, 'output', 'study-408-8738-raw.json');
const raw = JSON.parse(fs.readFileSync(designPath, 'utf8'));
// 真实矢量资源表(<name>-svgs.json, id->svg), 存在时图标以真实矢量参与闭环
let svgAssets = null;
const svgPath = designPath.replace('-raw.json', '-svgs.json');
if (fs.existsSync(svgPath)) {
  svgAssets = {};
  const exported = JSON.parse(fs.readFileSync(svgPath, 'utf8'));
  for (const e of exported.svgs || []) svgAssets[e.id] = e.svg;
  console.log(`svg 资源表: ${Object.keys(svgAssets).length} 项`);
}

await initTextMetrics();

// 1. 蓝图生成(与 e2e 相同的展平方式)
const styles = {};
for (const s of raw.sections) Object.assign(styles, s.dsl?.styles || {});
const canvas = raw.meta?.canvas || { width: 375, height: 812 };
const flat = [];
const emitFlat = (n, ox, oy) => {
  const ls = n.layoutStyle || {};
  flat.push({ ...n, x: (ls.relativeX ?? 0) + ox, y: (ls.relativeY ?? 0) + oy, width: ls.width ?? 0, height: ls.height ?? 0, children: undefined,
    layoutStyle: { ...(n.layoutStyle || {}), relativeX: (ls.relativeX ?? 0) + ox, relativeY: (ls.relativeY ?? 0) + oy } });
  (n.children || []).forEach(c => emitFlat(c, ((ls.relativeX ?? 0) + ox), ((ls.relativeY ?? 0) + oy)));
};
for (const s of raw.sections) for (const dn of (s.dsl?.nodes || [])) emitFlat(dn, s.x, s.y);
const bp = generateCodeBlueprint({ canvas, nodes: flat, styles });

// 2. truth spec: 收集全部可见叶子(文本/带色容器)的绝对 bounds
const items = [];
const collectItems = (n) => {
  if (!n || typeof n !== 'object') return;
  const hasText = (n.text || '').length > 0 || n.type === 'TEXT';
  const b = n.bounds || {};
  // 真实矢量节点(导出表命中): 渲染自身矢量 + 递归子树(文字等仍需叠加),
  // 但跳过同样命中导出表的嵌套子项(父 svg 已含其图形, 防叠加重影)
  if (svgAssets && svgAssets[n.id]) {
    items.push({ type: 'SVG', id: n.id, bounds: { ...b } });
    for (const c of (n.children || [])) {
      if (svgAssets[c.id]) continue;
      collectItems(c);
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
  (n.children || []).forEach(collectItems);
};
[...(bp.tree || []), ...(bp.floatings || [])].forEach(collectItems);

const specTruth = { mode: 'truth', width: canvas.width, height: canvas.height, items, svgAssets };
const specFlex = { mode: 'flex', width: canvas.width, height: canvas.height, tree: bp.tree || [], floatings: bp.floatings || [], svgAssets };
fs.writeFileSync(path.join(buildDir, 'spec_truth.json'), JSON.stringify(specTruth));
fs.writeFileSync(path.join(buildDir, 'spec_flex.json'), JSON.stringify(specFlex));
console.log(`spec: truth items=${items.length}, flex roots=${specFlex.tree.length}, canvas=${canvas.width}x${canvas.height}`);

// 3. Flutter golden 渲染
function renderSpec(mode) {
  const r = spawnSync('flutter', ['test', 'test/golden_test.dart', '--update-goldens'], {
    cwd: harnessDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      BLUEPRINT_SPEC: path.join(buildDir, `spec_${mode}.json`),
      GOLDEN_OUT: `goldens/golden_${mode}.png`,
      MANIFEST_OUT: path.join(buildDir, `manifest_${mode}.json`),
    },
    timeout: 300000,
  });
  if (r.status !== 0 && r.status !== null) {
    console.error(`flutter test (${mode}) failed:\n${r.stdout?.slice(-2000)}\n${r.stderr?.slice(-2000)}`);
    process.exit(1);
  }
}
for (const mode of ['truth', 'flex']) renderSpec(mode);

// 4. 对比内核: 像素层 + 块级层(D2C 指标)
const pngTruth = fs.readFileSync(path.join(harnessDir, 'test', 'goldens', 'golden_truth.png'));
const pngFlex = fs.readFileSync(path.join(harnessDir, 'test', 'goldens', 'golden_flex.png'));
const pixel = comparePng(pngTruth, pngFlex);
fs.writeFileSync(path.join(buildDir, 'diff.png'), pixel.diffPng);

const manifestTruth = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest_truth.json'), 'utf8'));
const manifestFlex = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest_flex.json'), 'utf8'));
const blocks = blockMetrics(manifestTruth, manifestFlex, {
  designImg: decodePng(pngTruth),
  renderImg: decodePng(pngFlex),
  canvasWidth: canvas.width,
  canvasHeight: canvas.height,
});

console.log('像素层:', JSON.stringify({ diffPixels: pixel.diffPixels, diffRatio: pixel.diffRatio }));
console.log('块级层:', JSON.stringify({
  blockMatchRate: blocks.blockMatchRate,
  matchedPairs: blocks.matchedPairs,
  positionSimilarity: blocks.positionSimilarity,
  colorSimilarity: blocks.colorSimilarity,
  avgTextSimilarity: blocks.avgTextSimilarity,
}));
if (blocks.unmatchedRender.length > 0) {
  console.log('渲染侧未匹配块(幻觉/漏渲染):', JSON.stringify(blocks.unmatchedRender.slice(0, 5)));
}
console.log('产物:', buildDir);
