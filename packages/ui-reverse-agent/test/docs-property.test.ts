import { generateToolDocs, genRandomTree, checkInvariant } from "../dist/index.js";

let docs = generateToolDocs([{ name: 'test_tool', description: 'desc', parameters: { a: { type: 'string', description: 'param a', required: true } } }]);
if (!docs.includes('test_tool') || !docs.includes('param a')) throw new Error('docs');
console.log('docs', docs.slice(0,50));

let tree = genRandomTree(2,2);
if (!tree[0].children) throw new Error('gen');
let inv = checkInvariant(tree);
if (!inv.passed) throw new Error(`invariant ${inv.violations[0].rule}`);
console.log('property', inv.passed);
let bad = [{ id:'x', rect:{x:0,y:0,w:-1,h:10}, children:[] }];
let inv2 = checkInvariant(bad);
if (inv2.passed) throw new Error('should fail');
console.log('property fail', inv2.violations[0].rule);

console.log('docs-property OK ✓');
