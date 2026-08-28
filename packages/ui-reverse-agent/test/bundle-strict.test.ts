import { analyzeBundle, strictReport } from "../dist/index.js";

let a = analyzeBundle('dist/index.js');
if (!a.bytes || !a.minified) throw new Error(`bundle ${a.summary}`);
console.log('bundle', a.summary);
let r = strictReport();
if (!r.current.includes('strict:false')) throw new Error('strict report');
console.log('strict', r.current, r.next.slice(0,30));

console.log('bundle-strict OK ✓');
