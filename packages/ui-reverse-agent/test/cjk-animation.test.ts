import { isCjk, cjkFontFallback, cjkPunctWidth, extractAnimations, compareAnimations } from "../dist/index.js";

if (!isCjk('你好') || isCjk('hello')) throw new Error('isCjk');
console.log('isCjk', isCjk('你好'));
let fb = cjkFontFallback('Noto Sans');
if (!fb.includes('PingFang')) throw new Error('fallback');
console.log('fallback', fb.slice(0,30));
let w = cjkPunctWidth('你好，世界。');
if (w < 5) throw new Error(`width ${w}`);
console.log('punct width', w);

let anims = extractAnimations([{ id:'a', computed:{ animation:'fade 200ms ease' }, children: [{ id:'b', computed:{ transition:'all 300ms' }}] }]);
if (anims.length !== 2) throw new Error('extract');
console.log('extract', anims.length);
let cmp = compareAnimations([{id:'a', anim:'fade 200ms'}], [{id:'a', anim:'fade 260ms'}], 50);
if (cmp.passed) throw new Error('should mismatch 60>50');
console.log('compare fail', cmp.mismatches[0].delta);
let cmp2 = compareAnimations([{id:'a', anim:'fade 200ms'}], [{id:'a', anim:'fade 220ms'}], 50);
if (!cmp2.passed) throw new Error('should pass');
console.log('compare pass');

console.log('cjk-animation OK ✓');
