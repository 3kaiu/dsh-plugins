import { MARKETPLACE_META, describeComposition, runIntegrationFixture, integrationSuite } from "../dist/index.js";

if (MARKETPLACE_META.id !== 'ui-reverse' || MARKETPLACE_META.dsh.tools < 20) throw new Error('marketplace meta');
console.log('marketplace', MARKETPLACE_META.id, MARKETPLACE_META.dsh.tools);
let comp = describeComposition();
if (!comp.standalone.includes('ui-reverse')) throw new Error('composition');
console.log('composition', comp.standalone.slice(0,30));

const neutral = {
  format: 'neutral-render-tree-v1',
  meta: { canvas: { width: 1440, height: 900 } },
  root: { kind: 'page', width: 1440, height: 900, children: [
    { kind: 'container', name: 'header', x: 0, y: 0, width: 1440, height: 80, children: [
      { kind: 'text', name: 'title', x: 24, y: 28, width: 200, height: 24, text: 'Hi', font: { family: 'Inter', size: 18, weight: 600, lineHeight: 24 }, color: '#111' }
    ]}
  ]}
};
let r1 = runIntegrationFixture({ neutral, implementedTree: [{ name: 'header', rect: { x:0,y:0,w:1440,h:80 }, children: [{ name:'title', rect:{x:24,y:28,w:200,h:24}, text:'Hi', tag:'div' }] }], expectedScore: 0.9 });
if (!r1.passed) throw new Error(`r1 should pass ${r1.summary}`);
console.log('integration pass', r1.summary);
let suite = integrationSuite([
  { neutral, implementedTree: [{ name: 'header', rect: { x:0,y:0,w:1440,h:80 }, children: [{ name:'title', rect:{x:24,y:28,w:200,h:24}, text:'Hi', tag:'div' }] }], expectedScore: 0.9 },
  { neutral, implementedTree: [{ name: 'wrong', rect: { x:0,y:10,w:1440,h:80 }}], expectedScore: 0.99 },
]);
if (suite.passed !== 1 || suite.failed !== 1) throw new Error(`suite ${suite.summary}`);
console.log('suite', suite.summary);

console.log('marketplace-integration OK ✓');
