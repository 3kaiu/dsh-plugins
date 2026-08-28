import { evaluateRestoration, generateApiDocs, exampleSnippet } from "../dist/index.js";

let ev = evaluateRestoration({ blueprint: {}, implementedTree: [], score: { total: 0.96, layers: { geom: 0.9, type: 0.9, color: 0.9, struct: 0.9 } }, verify: { passed: true }, a11y: { passed: true }, durationMs: 1000 });
if (ev.grade !== 'B' || ev.weighted < 0.9) throw new Error(`eval ${ev.grade} ${ev.weighted}`);
console.log('evaluation', ev.grade, ev.weighted);

let docs = generateApiDocs([{ name: 'test_tool', description: 'desc', parameters: { a: { type: 'string', description: 'param' } } }]);
if (!docs.includes('test_tool')) throw new Error('docs');
console.log('typedoc', docs.slice(0,40));
let ex = exampleSnippet('reference_ingest');
if (!ex.includes('referenceIngest')) throw new Error('example');
console.log('example', ex.slice(0,30));

console.log('evaluation-typedoc OK ✓');
