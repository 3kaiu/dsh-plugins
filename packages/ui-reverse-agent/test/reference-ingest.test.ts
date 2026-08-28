import { apply, referenceIngest } from "../dist/index.js";

// ——— 通过真实注册工具路径验证 deps 接线（index.ts → referenceIngest）———
const registered = [];
const ctx = { tools: { register(def) { registered.push(def); return () => {}; } } };
apply(ctx);
const tool = registered.find(t => t.name === 'reference_ingest');
if (!tool) throw new Error('reference_ingest 未注册');

// 拍平稿 sections：此前 deps 未接线导致该分支永不执行、静默落盘空蓝图
const sections = [
  { id: 'bg', name: 'hero-bg', type: 'rect', x: 0, y: 0, width: 375, height: 812, dsl: { styles: {}, nodes: [] } },
  { id: 'card', name: 'learn-card', type: 'group', x: 24, y: 100, width: 327, height: 120, dsl: { styles: {}, nodes: [{ layoutStyle: {}, _color: '#ffffff', borderRadius: 12 }] } },
];
const out = await tool.execute({ dsl: sections, viewport: { width: 375, height: 812 } }, {});
console.log('flatten summary', JSON.stringify(out.summary));
if (!Array.isArray(out.blueprint.tree) || out.blueprint.tree.length === 0) throw new Error('拍平稿应产出非空树');
if (!out.summary.regions || out.summary.regions === 0) throw new Error('拍平稿应产出非空 regions');

// ——— fail-loud 守卫 ———
// 无任何输入 → 必须抛错而非静默空蓝图
let threw = false;
try { await referenceIngest({}, {}) } catch { threw = true }
if (!threw) throw new Error('无输入应抛错');

// 形态不支持的 dsl → 必须抛错而非静默空蓝图
threw = false;
try { await referenceIngest({ dsl: { foo: 1 } }, {}) } catch { threw = true }
if (!threw) throw new Error('不可解析 dsl 应抛错');

console.log('reference-ingest OK ✓');
