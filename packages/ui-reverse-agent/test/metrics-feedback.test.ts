import { createMetrics, estimateLoopCost, captureFeedback, loadFeedback, replayFeedback } from "../dist/index.js";
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

let m = createMetrics();
m.mark('parse', 0, 10); m.mark('screenshot', 10, 810); m.mark('parse', 810, 820);
let r = m.report();
if (!r.bottleneck || r.total !== 820) throw new Error(`metrics ${r.total}`);
console.log('metrics', r.bottleneck, r.total, r.suggestion.slice(0,20));

let c = estimateLoopCost({ sections: 10, viewports: 3, states: 1, hasBrowser: true });
if (c.screenshots !== 2400) throw new Error(`cost ${c.screenshots}`);
console.log('cost', c.total, c.for30);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-'));
const fp = path.join(dir, 'feedback.json');
captureFeedback({ iteration: 1, path: 'card', prop: 'gap', expected: 24, actual: 16, userCorrection: 24, reason: 'should be 24' }, { feedbackPath: fp });
captureFeedback({ iteration: 2, path: 'btn', prop: 'color', expected: '#111', actual: '#333', userCorrection: '#111' }, { feedbackPath: fp });
let fb = loadFeedback(fp);
if (fb.length !== 2) throw new Error('feedback 2');
console.log('feedback', fb.length);
let rep = replayFeedback(fb);
if (rep.spacingScale.length !== 1 || rep.colorPalette.length !== 1) throw new Error('replay');
console.log('replay', rep.summary);

console.log('metrics-feedback OK ✓');
