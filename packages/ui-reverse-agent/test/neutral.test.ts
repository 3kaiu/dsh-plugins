import { neutralIngest, neutralToBlueprint, verifyNeutral } from "../dist/index.js";
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

const neutral = {
  format: 'neutral-render-tree-v1',
  meta: { canvas: { width: 1440, height: 900, background: '#F3F4F8' }, diagnostics: { droppedSections: 0 } },
  root: {
    kind: 'page', width: 1440, height: 900, background: '#F3F4F8',
    children: [
      { kind: 'container', name: 'header', x: 0, y: 0, width: 1440, height: 80, children: [
        { kind: 'text', name: 'title', x: 24, y: 28, width: 200, height: 24, text: 'Hello', font: { family: 'Inter', size: 18, weight: 600, lineHeight: 24 }, color: '#111' }
      ]},
      { kind: 'icon', name: 'star', x: 100, y: 100, width: 24, height: 24, svg: '<svg><path d="M0 0"/></svg>', bitmap: true },
      { kind: 'image', name: 'cover', x: 0, y: 200, width: 1440, height: 300, url: 'assets/cover.webp' }
    ]
  }
};

let bp = neutralToBlueprint(neutral);
if (bp.canvas.width !== 1440 || bp.canvas.background !== '#F3F4F8') throw new Error('canvas');
if (bp.tree.length !== 3) throw new Error(`tree 3 got ${bp.tree.length}`);
if (bp.assets.icons.length !== 1 || bp.assets.images.length !== 1) throw new Error('assets');
if (bp.regions.length === 0) throw new Error('regions');
console.log('neutralToBlueprint', bp.canvas, bp.tree.map(t=>t.name).join(','));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-'));
const out = path.join(dir, 'blueprint.json');
let res = await neutralIngest({ neutralTree: neutral, outPath: out });
if (!fs.existsSync(out)) throw new Error('ingest out missing');
if (res.summary.regions !== 3) throw new Error('summary regions');
console.log('neutralIngest', res.summary);

// verify-neutral：实现侧完全对齐应 clean
const implementedTree = [
  { name: 'header', rect: { x: 0, y: 0, w: 1440, h: 80 }, children: [
    { name: 'title', rect: { x: 24, y: 28, w: 200, h: 24 }, text: 'Hello' }
  ]},
  { name: 'star', rect: { x: 100, y: 100, w: 24, h: 24 }},
  { name: 'cover', rect: { x: 0, y: 200, w: 1440, h: 300 }},
];
let v1 = verifyNeutral({ neutral, blueprint: bp, implementedTree, tolerance: 2 });
if (!v1.passed) throw new Error(`should pass got ${JSON.stringify(v1.violations)}`);
console.log('verifyNeutral pass', v1.summary);

// 偏移应检出 violation
const offTree = [
  { name: 'header', rect: { x: 0, y: 10, w: 1440, h: 80 }}, // y 偏移 10
];
let v2 = verifyNeutral({ neutral, blueprint: bp, implementedTree: offTree, tolerance: 2 });
if (v2.passed) throw new Error('should fail geometry');
console.log('verifyNeutral geometry fail', v2.violations[0].rule);

// 文本未命中走 warning（几何对齐，仅文本不同）
let v3 = verifyNeutral({ neutral, blueprint: bp, domDump: { tree: [{ name: 'header', rect: { x: 0, y: 0, w: 1440, h: 80 }, children: [{ name: 'title', rect: { x: 24, y: 28, w: 200, h: 24 }, text: 'World' }] },{ name: 'star', rect: { x: 100, y: 100, w: 24, h: 24 } },{ name: 'cover', rect: { x: 0, y: 200, w: 1440, h: 300 } }] }, tolerance: 2 });
if (v3.violations.length) throw new Error(`text miss should be warning not violation, got ${JSON.stringify(v3.violations)}`);
if (v3.warnings.length === 0) throw new Error('should have text warning');
console.log('verifyNeutral text warning', v3.warnings.length);

console.log('neutral OK ✓');
