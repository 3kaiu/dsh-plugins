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

// ——— 生成代码注入回归（不可信 neutral 树不得产生可执行/可逃逸的产物）———
const INJ_TEXT = '</div><img src=x onerror=alert(1)>';
const INJ_BG = "red'};process.exit(1);{'";
const INJ_ATTR = '" onmouseover="alert(1)"';
const INJ_SVG = '<svg onload=alert(1)></svg>';
const hostile = {
  format: 'x',
  meta: { canvas: { width: 100, height: 50, background: `#fff${INJ_ATTR}` } },
  root: { kind: 'page', width: 100, height: 50, children: [
    { kind: 'container', x: INJ_ATTR, y: 0, width: 10, height: 10, bg: INJ_BG, children: [
      { kind: 'text', text: INJ_TEXT },
      { kind: 'icon', svg: INJ_SVG }
    ]}
  ]}
};
const hVue = neutralToVue(hostile);
const hReact = neutralToReact(hostile);

// react：文本必须以 JS 字符串字面量进入，且不存在裸文本节点
if (!hReact.includes(JSON.stringify(INJ_TEXT))) throw new Error('react text not stringified');
if (hReact.includes('>' + INJ_TEXT)) throw new Error('react raw text node');
if (!hReact.includes(`background:${JSON.stringify(INJ_BG)}`)) throw new Error('react bg not stringified');
if (hReact.includes(`'${INJ_BG}'`)) throw new Error('react bg raw literal');
if (hReact.includes('onmouseover="')) throw new Error('react attr breakout');
if (hReact.includes('<svg')) throw new Error('react raw svg');

// vue：文本转义、style 属性无逃逸、SVG 不内联
if (hVue.includes('<img src=x') || hVue.includes('<svg')) throw new Error('vue raw html/svg');
if (!hVue.includes('&lt;img')) throw new Error('vue text not escaped');
if (hVue.includes('" onmouseover') || hVue.includes("'")) throw new Error('vue style attr breakout');
if (hVue.includes(';process') || hVue.includes(';}')) throw new Error('vue css declaration injection');

console.log('adapter-injection OK ✓');
console.log('adapter-visual OK ✓');
