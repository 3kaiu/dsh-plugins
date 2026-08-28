// dsl-clean 原型污染防御回归：不可信 sections 的 _dsl.styles 自有键
// "__proto__"/"constructor"/"prototype" 不得改写合并目标原型，合法键照常合并。
import { cleanToStandardDsl } from "../dist/index.js";

const sections = [
  {
    id: 'card', name: 'learn-card', type: 'group',
    x: 24, y: 100, width: 200, height: 120,
    dsl: {
      styles: {
        color: { value: '#ffffff' },
        __proto__: { polluted: true },
        constructor: { value: 'evil' },
      },
      nodes: [],
    },
  },
];

const out = cleanToStandardDsl({ canvas: { width: 375, height: 812 }, sections });

// 1) 全局原型未被污染
const probe = {};
if (probe.polluted !== undefined) throw new Error('Object.prototype 被 __proto__ 键污染');
if (probe.value === 'evil') throw new Error('Object.prototype 被 constructor 键污染');

// 2) 合并目标自身的原型未被篡改（键查询不落入攻击者对象）
if (out.styles.polluted !== undefined) throw new Error('styles 原型被篡改');

// 3) 合法键照常合并
if (out.styles.color?.value !== '#ffffff') throw new Error(`合法 style 键丢失: ${JSON.stringify(out.styles.color)}`);

// 4) 危险键不得以自有属性形式存活在结果里
if (Object.keys(out.styles).some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype'))
  throw new Error('危险键仍存在于 styles');

console.log('dsl-clean proto-guard OK ✓');
