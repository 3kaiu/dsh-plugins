import { expandMatrix, aggregateMatrixScores, checkResponsive, mapTypographyTokens, mapPaletteTokens } from "../dist/index.js";

let m = expandMatrix({ viewports: ['desktop','mobile'], states: ['default','hover'] });
if (m.length !== 4) throw new Error(`matrix 4 got ${m.length}`);
if (!m.some(x=>x.key==='desktop-default')) throw new Error('key');
console.log('expandMatrix', m.map(x=>x.key).join(','));

let agg = aggregateMatrixScores([
  { key:'desktop-default', viewport:{name:'desktop'}, state:'default', score:{total:0.9}},
  { key:'mobile-default', viewport:{name:'mobile'}, state:'default', score:{total:0.8}},
  { key:'desktop-hover', viewport:{name:'desktop'}, state:'hover', score:{total:0.85}},
]);
if (agg.aggregate < 0.8 || agg.aggregate > 0.9) throw new Error(`aggregate ${agg.aggregate}`);
if (agg.worst.key !== 'mobile-default') throw new Error('worst');
console.log('aggregate', agg.aggregate, 'worst', agg.worst.key);

let resp = checkResponsive([
  { key:'desktop-default', viewport:{name:'desktop'}, score:{total:0.9}},
  { key:'mobile-default', viewport:{name:'mobile'}, score:{total:0.7}},
], 0.85);
if (resp.passed) throw new Error('should fail');
console.log('responsive', resp.issues.length);

let typo = mapTypographyTokens({ 'header>title': { family:'Inter', size:18, weight:600 } }, [{ name:'text-base', family:'Inter', size:18, weight:600, cssVar:'--text-base' }]);
if (typo[0].action !== 'reuse') throw new Error(`typo reuse ${typo[0].action}`);
console.log('typo map', typo[0].suggestion);

let pal = mapPaletteTokens([{hex:'#111'}, {hex:'#ff0000'}], ['#111111', '#ffffff'], 3);
if (pal[0].action !== 'reuse') throw new Error(`pal reuse ${pal[0].action} ${pal[0].deltaE}`);
if (pal[1].action !== 'create') throw new Error('red should create');
console.log('palette map', pal.map(p=>`${p.blueprint}:${p.action}`).join(','));

console.log('viewport-token OK ✓');
