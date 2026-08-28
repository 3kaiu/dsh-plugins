import { classifyByExpert, planParallelExperts, mergeExpertResults, generateHandoff } from "../dist/index.js";

let mism = [{ prop: 'gap', delta: 8 }, { prop: 'color', delta: 5 }, { prop: 'fontSize', delta: 2 }, { prop: 'width', delta: 10 }];
let by = classifyByExpert(mism);
if (by.layout.length !== 2 || by.style.length !== 1 || by.content.length !== 1) throw new Error(`classify ${JSON.stringify(by)}`);
console.log('classify', by.layout.length, by.style.length, by.content.length);
let plan = planParallelExperts(mism);
if (!plan.canParallel || plan.plans.length !== 3) throw new Error('plan');
console.log('plan', plan.plans.map(p=>p.expert).join(','));
let merged = mergeExpertResults([{ expert:'layout', score:{total:0.9}, changes:['gap'] }, { expert:'style', score:{total:0.85}, changes:['color'] }]);
if (merged.totalScore !== 0.875) throw new Error(`merge ${merged.totalScore}`);
console.log('merge', merged.summary);

let handoff = generateHandoff({ blueprint: { canvas:{width:1440,height:900,background:'#fff'}, assets:{icons:[{name:'star'}],images:[],fonts:['Inter']}, regions:[{},{}] }, state: { iteration:5, scores:{current:{total:0.97}}, remainingDifferences:[{priority:'P2',path:'x',prop:'color',expected:'#fff',actual:'#000',delta:1}], resolvedDifferences:[{path:'header',prop:'height',iteration:2}] }, score: { total:0.97, layers:{struct:0.9,geom:0.9}}});
if (!handoff.includes('UI 还原交付文档') || !handoff.includes('S 0.97')) throw new Error('handoff');
console.log('handoff', handoff.slice(0,40));

console.log('multi-handoff OK ✓');
