import { neutralToVue, neutralToReact, toPercySnapshot, toChromaticSnapshot } from "../dist/index.js";

const neutral = {
  format: 'neutral-render-tree-v1',
  meta: { canvas: { width: 1440, height: 900, background: '#fff' } },
  root: { kind: 'page', width: 1440, height: 900, children: [
    { kind: 'container', name: 'header', x: 0, y: 0, width: 1440, height: 80, children: [
      { kind: 'text', name: 'title', x: 24, y: 28, width: 200, height: 24, text: 'Hi', font: { family: 'Inter', size: 18 } }
    ]}
  ]}
};
let vue = neutralToVue(neutral);
if (!vue.includes('<template>') || !vue.includes('Hi')) throw new Error('vue');
console.log('vue', vue.slice(0,60));
let react = neutralToReact(neutral);
if (!react.includes('export default') || !react.includes('Hi')) throw new Error('react');
console.log('react', react.slice(0,60));
let percy = toPercySnapshot({ name: 'test', url: 'http://localhost:3000' });
if (percy.widths.length !== 3) throw new Error('percy');
console.log('percy', percy.name);
let chrom = toChromaticSnapshot({ name: 'test', viewport: 'mobile', diffPath: 'diff.png', score: { total: 0.97 } });
if (!chrom.passed) throw new Error('chromatic pass');
console.log('chromatic', chrom.passed);

console.log('adapter-visual OK ✓');
