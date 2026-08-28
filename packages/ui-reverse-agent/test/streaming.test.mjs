import { createStream, livePreviewHtml } from "../dist/index.js";

let s = createStream();
s.push('progress', { iteration: 1, score: 0.8 });
s.push('progress', { iteration: 2, score: 0.85 });
let snap = s.snapshot();
if (snap.length !== 2) throw new Error('snapshot');
let flushed = s.flush();
if (flushed.length !== 2 || s.snapshot().length !== 0) throw new Error('flush');
console.log('stream', flushed[0].event, flushed[0].data.iteration);

let html = livePreviewHtml({ blueprint: { regions: [{ name: 'header', priority: 'P0' }], canvas: { width: 1440, height: 900, background: '#fff' } }, score: { total: 0.9 }, iteration: 2 });
if (!html.includes('Iteration 2') || !html.includes('header')) throw new Error('preview');
console.log('preview', html.slice(0,50));

console.log('streaming OK ✓');
