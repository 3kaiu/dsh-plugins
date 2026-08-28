import { detectLsp, mapSingleNode, mapBlueprint, collectCandidatesWithLsp } from "../dist/index.js";

console.log('detectLsp none', detectLsp(null).available === false ? 'ok' : 'fail');
console.log('detectLsp empty ctx', detectLsp({}).available === false ? 'ok' : 'fail');
const mockLsp = { search: async () => [{ file: 'src/components/Card.tsx', score: 0.9, name: 'card' }] };
console.log('detectLsp mock', detectLsp({ lsp: mockLsp }).available === true ? 'ok' : 'fail');

// mapSingleNode
let m1 = mapSingleNode({ name: 'card', role: 'card' }, [{ file: 'src/components/Card.tsx', score: 0.9, source: 'lsp', matchedName: 'card' }]);
if (m1.status !== 'reuse' || m1.confidence !== 1) throw new Error('lsp exact should reuse');
console.log('mapSingleNode lsp exact ok', m1.status);

let m2 = mapSingleNode({ name: 'header' }, []);
if (m2.status !== 'unmapped') throw new Error('empty should unmapped');
console.log('mapSingleNode unmapped ok');

let m3 = mapSingleNode({ name: 'footer' }, [{ file: 'src/foo.ts', score: 0.5 }]);
if (m3.status !== 'create' && m3.status !== 'maybe') throw new Error('non-component should create');
console.log('mapSingleNode create ok');

// mapBlueprint
const bp = { tree: [{ id:'a', name:'header' }, { id:'b', name:'card', children: [{ id:'b1', name:'button' }] }] };
const byNode = new Map();
byNode.set('header', [{ file: 'src/Header.tsx', score: 0.8, source: 'grep' }]);
byNode.set('card', [{ file: 'src/Card.tsx', score: 0.9, source: 'lsp', matchedName: 'card' }]);
let res = mapBlueprint(bp, byNode);
if (res.summary.total !== 3) throw new Error(`total 3 got ${res.summary.total}`);
console.log('mapBlueprint', res.summary);

// collectCandidatesWithLsp fallback
let c1 = await collectCandidatesWithLsp({}, { name: 'card' });
if (c1.source !== 'none') throw new Error('should fallback');
console.log('collect fallback ok', c1.reason);
let c2 = await collectCandidatesWithLsp({ lsp: mockLsp }, { name: 'card' });
if (c2.source !== 'lsp' || c2.candidates.length !== 1) throw new Error('lsp search should return');
console.log('collect lsp ok', c2.candidates[0].file);
console.log('lsp-map OK ✓');
