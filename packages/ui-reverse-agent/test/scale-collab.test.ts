import { chunkFiles, incrementalPlan, createComment, resolveComment, threadForPath } from "../dist/index.js";

let chunks = chunkFiles(Array.from({length:250},(_,i)=>`f${i}`), 100);
if (chunks.length !== 3 || chunks[0].length !== 100) throw new Error('chunk');
console.log('chunk', chunks.length);

let plan = incrementalPlan({ changedFiles: ['src/a.ts'], allFiles: ['src/a.ts','src/b.ts','other/c.ts'] });
if (!plan.affected.includes('src/b.ts')) throw new Error('incremental');
console.log('incremental', plan.affected.length, plan.ratio);

let c = createComment({ author: 'alice', text: 'gap should be 24', path: 'card', pos: { x: 10, y: 20 } });
if (!c.id || c.resolved) throw new Error('comment');
let resolved = resolveComment([c], c.id);
if (!resolved[0].resolved) throw new Error('resolve');
let thread = threadForPath([c, createComment({ author:'bob', text:'ok', path:'other', pos:{} })], 'card');
if (thread.length !== 1) throw new Error('thread');
console.log('collab', thread.length);

console.log('scale-collab OK ✓');
