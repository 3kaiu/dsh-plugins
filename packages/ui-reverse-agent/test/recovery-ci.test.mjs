import { classifyError, recoveryPlan, withRetry, buildCiReport, ciGate } from "../dist/index.js";

let c1 = classifyError(new Error('ECONNREFUSED port 3000'));
if (c1 !== 'devServer') throw new Error(`devServer ${c1}`);
let c2 = classifyError('browser chromium failed');
if (c2 !== 'browser') throw new Error('browser');
console.log('classify', c1, c2);

let p1 = recoveryPlan(new Error('ECONNREFUSED'), 0);
if (!p1.retry || p1.kind !== 'devServer') throw new Error('retry');
console.log('recovery', p1.reason);
let p2 = recoveryPlan(new Error('ECONNREFUSED'), 2);
if (p2.retry) throw new Error('should fallback');
console.log('fallback', p2.fallback);

let n = 0;
let res = await withRetry(async () => { n++; if (n < 2) throw new Error('network timeout'); return 42 }, { kind: 'network', maxRetries: 3, delayMs: 1 });
if (res !== 42 || n !== 2) throw new Error('withRetry');
console.log('withRetry', res, n);

let report = buildCiReport({ state: { scores: { current: { total: 0.97 } }, remainingDifferences: [], iteration: 5, antiHack: { violations: [] } }, artifacts: ['diff.png'] });
if (!report.passed || report.total !== 0.97) throw new Error('ci pass');
console.log('ci pass', report.summary);
let report2 = buildCiReport({ state: { scores: { current: { total: 0.92 } }, remainingDifferences: [{ priority: 'P0' }], iteration: 5 } });
if (report2.passed) throw new Error('should fail P0');
let gate = ciGate(report2);
if (gate.pass) throw new Error('gate should fail');
console.log('ci fail', gate.reason);

console.log('recovery-ci OK ✓');
