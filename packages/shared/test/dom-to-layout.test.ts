// domToLayout 确定性回归：无 id/selector 的节点两次构建必须产出完全一致的结果
// （此前 Math.random 兜底 id 使同一 DOM 两次 dump 结果不同，破坏回归对比）。
import { domToLayout } from "../dist/index.js";

const dump = {
  viewport: { width: 1440, height: 900 },
  tree: [
    {
      tag: 'DIV', rect: { x: 0, y: 0, w: 1440, h: 80 },
      children: [
        { tag: 'SPAN', rect: { x: 24, y: 28, w: 200, h: 24 }, text: 'Hi' },
        { tag: 'IMG', rect: { x: 1200, y: 20, w: 40, h: 40 } },
      ],
    },
  ],
};
const a = domToLayout(dump);
const b = domToLayout(dump);
if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('同一 DOM 两次构建结果不一致（id 非确定性）');
const root = a.tree?.[0] ?? a[0];
if (!String(root.id).startsWith('dom:')) throw new Error(`兜底 id 形态异常: ${root.id}`);
if (root.children.some((c) => String(c.id).includes('random'))) throw new Error('仍存在随机 id');
console.log('dom-to-layout deterministic OK ✓');
