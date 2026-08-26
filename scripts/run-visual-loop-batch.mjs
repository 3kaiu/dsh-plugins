// 批量视觉闭环基线: 对全部 fixture 跑 truth/flex 双模式渲染 + 三层指标, 输出回归基线表
//
// 用法: node scripts/run-visual-loop-batch.mjs [fixtures目录]
//   默认 packages/layout-infer/fixtures/ 下 mg-pure-sec-*.json
// 产物: visual-loop/build/batch/<name>/... 与基线汇总 stdout(可存档对比)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateCodeBlueprint, initTextMetrics, comparePng, blockMetrics, decodePng } from '../packages/ui-restore/dist/index.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(rootDir, 'visual-loop', 'build', 'batch');
const harnessDir = path.join(rootDir, 'visual-loop', 'flutter_harness');
const fixturesDir = process.argv[2] || path.join(rootDir, 'packages', 'layout-infer', 'fixtures');
fs.mkdirSync(buildDir, { recursive: true });

await initTextMetrics();

const files = fs.readdirSync(fixturesDir).filter(f => /^mg-pure-sec-\d+\.json$/.test(f)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
const entries = [];
const skipped = [];
const blueprints = new Map();

for (const f of files) {
  const name = f.replace('.json', '');
  const fx = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'));
  const styles = fx.dsl?.styles || {};
  const nodes = fx.dsl?.nodes || [];
  if (nodes.length === 0) continue;
  // 画布: 节点包围盒(向上取整, 下限 100x100)
  const bbox = (acc, n) => {
    const ls = n.layoutStyle || {};
    acc.x2 = Math.max(acc.x2, (ls.relativeX ?? 0) + (ls.width ?? 0));
    acc.y2 = Math.max(acc.y2, (ls.relativeY ?? 0) + (ls.height ?? 0));
    (n.children || []).forEach(c => bbox(acc, c));
    return acc;
  };
  const acc = nodes.reduce((a, n) => bbox(a, n), { x2: 0, y2: 0 });
  const canvas = { width: Math.max(100, Math.ceil(acc.x2)), height: Math.max(100, Math.ceil(acc.y2)) };
  // 展平为绝对坐标(section 原点即 0,0)
  const flat = [];
  const emitFlat = (n) => {
    const ls = n.layoutStyle || {};
    flat.push({ ...n, x: ls.relativeX ?? 0, y: ls.relativeY ?? 0, width: ls.width ?? 0, height: ls.height ?? 0, children: undefined,
      layoutStyle: { ...(n.layoutStyle || {}) } });
    (n.children || []).forEach(c => emitFlat(c));
  };
  nodes.forEach(emitFlat);

  const bp = generateCodeBlueprint({ canvas, nodes: flat, styles });
  blueprints.set(name, bp);

  const items = [];
  const collectItems = (n) => {
    if (!n || typeof n !== 'object') return;
    const hasText = (n.text || '').length > 0 || n.type === 'TEXT';
    const b = n.bounds || {};
    if (hasText && n.text) items.push({ type: 'TEXT', text: String(n.text), bounds: { ...b }, color: n.color, fontSize: n.fontSize, fontWeight: n.fontWeight, lineHeight: n.lineHeight, letterSpacing: n.letterSpacing });
    else if (n.color && !hasText) items.push({ type: 'BOX', bounds: { ...b }, color: n.color, layout: { borderRadius: n.layout?.borderRadius } });
    (n.children || []).forEach(collectItems);
  };
  [...(bp.tree || []), ...(bp.floatings || [])].forEach(collectItems);
  if (items.length === 0) { console.log(`skip ${name}: 无可见元素(纯背景 section)`); skipped.push(name); continue; }

  const dir = path.join(buildDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec_truth.json'), JSON.stringify({ mode: 'truth', width: canvas.width, height: canvas.height, items }));
  fs.writeFileSync(path.join(dir, 'spec_flex.json'), JSON.stringify({ mode: 'flex', width: canvas.width, height: canvas.height, tree: bp.tree || [], floatings: bp.floatings || [] }));
  entries.push({ name, spec: path.join(dir, 'spec_truth.json'), golden: `goldens/batch/${name}_truth.png`, manifest: path.join(dir, 'manifest_truth.json') });
  entries.push({ name, spec: path.join(dir, 'spec_flex.json'), golden: `goldens/batch/${name}_flex.png`, manifest: path.join(dir, 'manifest_flex.json') });
}

fs.mkdirSync(path.join(harnessDir, 'test', 'goldens', 'batch'), { recursive: true });
const manifestPath = path.join(buildDir, 'batch_manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(entries));
console.log(`batch: ${blueprints.size} fixtures, ${entries.length} renders`);

const r = spawnSync('flutter', ['test', 'test/batch_test.dart', '--update-goldens'], {
  cwd: harnessDir, encoding: 'utf8',
  env: { ...process.env, BATCH_MANIFEST: manifestPath },
  timeout: 900000,
});
if (r.status !== 0 && r.status !== null) {
  console.error(`flutter batch failed:\n${r.stdout?.slice(-3000)}\n${r.stderr?.slice(-2000)}`);
  process.exit(1);
}

// 汇总指标
const rows = [];
for (const name of blueprints.keys()) {
  const pngT = path.join(harnessDir, 'test', 'goldens', 'batch', `${name}_truth.png`);
  const pngF = path.join(harnessDir, 'test', 'goldens', 'batch', `${name}_flex.png`);
  const manT = path.join(buildDir, name, 'manifest_truth.json');
  const manF = path.join(buildDir, name, 'manifest_flex.json');
  if (!fs.existsSync(pngT) || !fs.existsSync(pngF) || !fs.existsSync(manT) || !fs.existsSync(manF)) {
    rows.push({ name, error: 'missing artifacts' });
    continue;
  }
  void skipped;
  const pT = fs.readFileSync(pngT), pF = fs.readFileSync(pngF);
  const pixel = comparePng(pT, pF);
  fs.writeFileSync(path.join(buildDir, name, 'diff.png'), pixel.diffPng);
  const blocks = blockMetrics(JSON.parse(fs.readFileSync(manT, 'utf8')), JSON.parse(fs.readFileSync(manF, 'utf8')), {
    designImg: decodePng(pT), renderImg: decodePng(pF),
    canvasWidth: blueprints.get(name).canvas?.width, canvasHeight: blueprints.get(name).canvas?.height,
  });
  rows.push({
    name,
    diffRatio: pixel.diffRatio,
    blockMatch: blocks.blockMatchRate,
    posSim: blocks.positionSimilarity,
    colorSim: blocks.colorSimilarity,
    pairs: blocks.matchedPairs,
  });
}

console.log('\nname                 diff    blockMatch  posSim  colorSim  pairs');
for (const row of rows) {
  if (row.error) { console.log(`${row.name}  ERROR: ${row.error}`); continue; }
  console.log(`${row.name.padEnd(20)} ${String(row.diffRatio).padEnd(7)} ${String(row.blockMatch).padEnd(11)} ${String(row.posSim).padEnd(7)} ${String(row.colorSim).padEnd(9)} ${row.pairs}`);
}
const ok = rows.filter(r => !r.error);
const mean = (arr) => arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
function round2(n) { return Math.round(n * 100) / 100; }
console.log('\n基线汇总:', JSON.stringify({
  fixtures: ok.length,
  skippedPureBackground: skipped.length,
  meanDiffRatio: mean(ok.map(r => r.diffRatio)),
  maxDiffRatio: ok.length ? round2(Math.max(...ok.map(r => r.diffRatio))) : null,
  meanBlockMatch: mean(ok.map(r => r.blockMatch)),
  meanPosSim: mean(ok.map(r => r.posSim)),
  meanColorSim: mean(ok.map(r => r.colorSim)),
}));
