// ui-restore 分叉副本的同款原型污染守卫（与 shared/src/dsl-clean.ts 独立实现，各自锁）
import { cleanToStandardDsl } from "../dist/index.js";

const sections = [{
  id: 'card', name: 'learn-card', type: 'group',
  x: 24, y: 100, width: 200, height: 120,
  dsl: { styles: { color: { value: '#fff' }, __proto__: { polluted: true } }, nodes: [] },
}];
const out = cleanToStandardDsl({ canvas: { width: 375, height: 812 }, sections });
if (({}).polluted !== undefined) throw new Error('Object.prototype 被污染');
if (out.styles.polluted !== undefined) throw new Error('styles 原型被篡改');
if (out.styles.color?.value !== '#fff') throw new Error('合法键丢失');
console.log('dsl-clean-guard OK ✓');
