import { fanoutEvaluate, generateCandidates } from "../dist/index.js";

const referenceTree = [
  { id: 'a', name: 'header', rect: { x: 0, y: 0, w: 1440, h: 80 }, children: [] },
  { id: 'b', name: 'card-grid', rect: { x: 0, y: 80, w: 1440, h: 400 }, computed: { gap: 24 }, children: [] }
];
const implementedTree = [
  { id: 'a', name: 'header', rect: { x: 0, y: 0, w: 1440, h: 64 }, children: [] },
  { id: 'b', name: 'card-grid', rect: { x: 0, y: 80, w: 1440, h: 400 }, computed: { gap: 16 }, children: [] }
];

const mismatch = { path: 'header', prop: 'height', expected: 80, actual: 64, delta: 16, priority: 'P0' };
const cands = [{ value: 80, label: '80 期望' }, { value: 70, label: '70' }, { value: 64, label: '64 现状' }];
const res = fanoutEvaluate({ mismatch, candidates: cands, referenceTree, implementedTree, tolerance: 2, currentScore: 0.82 });
console.log('fanout ranked', res.ranked.map(r=>`${r.rank}:${r.label} total=${r.predictedTotal} mism=${r.mismatchesAfter}`).join(' | '));
if (res.ranked.length !== 3) throw new Error('应 3 候选');
if (res.best.value !== 80) throw new Error(`最优应 80 得 ${res.best.value}`);
if (!res.recommendation.includes('80')) throw new Error('recommendation 缺失');
console.log('fanout_evaluate ✓');

// 自动生成候选
const auto = generateCandidates({ path: 'x', prop: 'gap', expected: 24, actual: 16 });
if (auto.length !== 3 || auto[0].value !== 24) throw new Error('generateCandidates 失败');
console.log('generateCandidates', auto.map(c=>c.value).join(','));
// 并发安全标记
import { apply } from "../dist/index.js";
const regs=[]; apply({ tools:{register(d){regs.push(d)}}, systemPrompt:{ section(){}, variable(){} } });
const fanoutTool = regs.find(t=>t.name==='fanout_evaluate');
if (!fanoutTool) throw new Error('缺少 fanout_evaluate 注册');
if (typeof fanoutTool.isConcurrencySafe !== 'function') throw new Error('fanout_evaluate 需 isConcurrencySafe');
console.log('isConcurrencySafe ✓', typeof fanoutTool.isConcurrencySafe);
console.log('fanout OK ✓');
