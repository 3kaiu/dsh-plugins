import { checkDesignConstraints, filterByConstraints, hashOf, cacheKey, getCached, setCached } from "../dist/index.js";
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

// spacing
let r1 = checkDesignConstraints({ prop: 'gap', value: 24, path: 'card' }, { spacingScale: [0,4,8,16,24,32] });
if (!r1.passed) throw new Error('24 should pass');
console.log('spacing pass', r1.summary);
let r2 = checkDesignConstraints({ prop: 'gap', value: 13, path: 'card' }, { spacingScale: [0,4,8,16,24,32] });
if (r2.passed) throw new Error('13 should fail');
console.log('spacing fail', r2.violations[0].nearest);
let r3 = checkDesignConstraints({ prop: 'color', value: '#ff0000', path: 'btn' }, { colorPalette: ['#ff0000','#fff'] });
if (!r3.passed) throw new Error('color should pass');
let r4 = checkDesignConstraints({ prop: 'color', value: '#123456', path: 'btn' }, { colorPalette: ['#ff0000'] });
if (!r4.passed || r4.warnings.length === 0) throw new Error('color should warn with passed true');
console.log('color warn', r4.warnings.length);
let r5 = checkDesignConstraints({ prop: 'fontSize', value: 16, path: 'title' }, { typographyScale: { sizes: [12,14,16,18] } });
if (!r5.passed) throw new Error('fontSize 16 should pass');
console.log('typo pass', r5.summary);
// filter
let ranked = [{ value: 24, _prop: 'gap' }, { value: 13, _prop: 'gap' }];
let f = filterByConstraints(ranked, { spacingScale: [0,4,8,16,24,32] });
if (f.filtered.length !== 1 || f.blocked.length !== 1) throw new Error('filter');
console.log('filter', f.filtered[0].value, 'blocked', f.blocked[0].value);

// cache
let h = hashOf({ a: 1 });
if (h.length !== 8) throw new Error('hash');
let key = cacheKey({ kind: 'blueprint', dslHash: h, viewport: { width: 1440, height: 900 }, state: 'default', tolerance: 2 });
if (!key.includes('blueprint')) throw new Error('key');
console.log('cache key', key);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-'));
setCached(key, { v: 1 }, dir);
let v = getCached(key, dir);
if (!v || v.v !== 1) throw new Error('cache get');
console.log('cache ok', v);

console.log('design-cache OK ✓');
