// 视觉闭环驱动: 蓝图 -> Flutter 双模式渲染(truth/flex) -> 像素+块级指标对比
//
// 用法: node scripts/run-visual-loop.mjs [设计稿json路径]
//   默认使用 output/study-408-8738-raw.json
// 产物目录: visual-loop/build/
//   spec_truth.json / spec_flex.json   两份渲染 spec
//   golden_truth.png / golden_flex.png golden 渲染(首次 --update-goldens 自动写入)
//   manifest_truth.json / manifest_flex.json  真实渲染文本块清单
//   diff.png                            pixelmatch 差异蒙版
// 公共核(展平/收集/flutter/对比)在 ./visual-loop-shared.mjs(与 batch 版共用)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCodeBlueprint, initTextMetrics } from '../packages/ui-restore/dist/index.js';
import { collectSpecItems, flattenNodes, runFlutterGolden, comparePair } from './visual-loop-shared.mjs';

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
const flat = raw.sections.flatMap((s) => flattenNodes(s.dsl?.nodes || [], s.x, s.y));
const bp = generateCodeBlueprint({ canvas, nodes: flat, styles });

// 2. truth/flex spec(收集器单源, 含 svg 资源表支持)
const items = collectSpecItems(bp.tree, bp.floatings, svgAssets);
const specTruth = { mode: 'truth', width: canvas.width, height: canvas.height, items, svgAssets };
const specFlex = { mode: 'flex', width: canvas.width, height: canvas.height, tree: bp.tree || [], floatings: bp.floatings || [], svgAssets };
fs.writeFileSync(path.join(buildDir, 'spec_truth.json'), JSON.stringify(specTruth));
fs.writeFileSync(path.join(buildDir, 'spec_flex.json'), JSON.stringify(specFlex));
console.log(`spec: truth items=${items.length}, flex roots=${specFlex.tree.length}, canvas=${canvas.width}x${canvas.height}`);

// 3. Flutter golden 渲染
for (const mode of ['truth', 'flex']) {
  runFlutterGolden(harnessDir, 'test/golden_test.dart', {
    ...process.env,
    BLUEPRINT_SPEC: path.join(buildDir, `spec_${mode}.json`),
    GOLDEN_OUT: `goldens/golden_${mode}.png`,
    MANIFEST_OUT: path.join(buildDir, `manifest_${mode}.json`),
  }, 300000, `flutter test (${mode})`);
}

// 4. 对比内核: 像素层 + 块级层(D2C 指标)
const pngTruth = fs.readFileSync(path.join(harnessDir, 'test', 'goldens', 'golden_truth.png'));
const pngFlex = fs.readFileSync(path.join(harnessDir, 'test', 'goldens', 'golden_flex.png'));
const manifestTruth = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest_truth.json'), 'utf8'));
const manifestFlex = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest_flex.json'), 'utf8'));
const { pixel, blocks } = comparePair({
  pngTruth, pngFlex, manifestTruth, manifestFlex, canvas,
  diffOut: path.join(buildDir, 'diff.png'),
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
