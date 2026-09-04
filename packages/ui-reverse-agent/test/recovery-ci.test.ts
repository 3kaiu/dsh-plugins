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

// ci_report × core 四闸：blueprint.meta.gates 任一 FAIL → 不通过（即使分数达标）
let report3 = buildCiReport({
  state: { scores: { current: { total: 0.99 } }, remainingDifferences: [], iteration: 3 },
  blueprint: { meta: { gates: { contract: 'PASS', geometry: 'FAIL_GEOMETRY (12.5px)', style: 'PASS_STYLE_CONSERVED', truth: 'PASS_TRUTH_PERFECT' } } },
});
if (report3.passed) throw new Error('ci should fail on gate FAIL');
if (report3.gateFails?.[0] !== 'geometry=FAIL_GEOMETRY (12.5px)') throw new Error(`gateFails: ${JSON.stringify(report3.gateFails)}`);
let gate3 = ciGate(report3);
if (gate3.pass) throw new Error('gate3 should fail');
if (!/gates/.test(gate3.reason)) throw new Error(`gate3 reason: ${gate3.reason}`);
console.log('ci gate-fail', gate3.reason);

// 四闸全 PASS + 分数达标 → 通过，且 gates 落进 report
let report4 = buildCiReport({
  state: { scores: { current: { total: 0.99 } }, remainingDifferences: [], iteration: 4 },
  blueprint: { meta: { gates: { contract: 'PASS', geometry: 'PASS_PIXEL_PERFECT (100% 1:1 零失真)', style: 'PASS_STYLE_CONSERVED', truth: 'PASS_TRUTH_PERFECT' } } },
});
if (!report4.passed) throw new Error(`ci4 should pass: ${report4.summary}`);
if (!report4.gates || report4.gates.truth !== 'PASS_TRUTH_PERFECT') throw new Error('gates not surfaced');
let gate4 = ciGate(report4);
if (!gate4.pass) throw new Error('gate4 should pass');
console.log('ci gates pass', report4.summary);

// 无 blueprint（旧调用形态）→ 行为不变
let report5 = buildCiReport({ state: { scores: { current: { total: 0.97 } }, remainingDifferences: [] } });
if (!report5.passed || report5.gates) throw new Error('legacy shape changed');

console.log('recovery-ci OK ✓');
