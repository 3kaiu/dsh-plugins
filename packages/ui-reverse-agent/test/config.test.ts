// Config 契约测试: yml config 经 schemastery 校验 → applyConfig → runtimeConfig,
// persona 变量与门禁阈值必须反映用户覆盖(此前 yml config 被 apply 静默丢弃)。
import { apply, applyConfig, runtimeConfig, Config } from "../dist/index.js";

// 1) Config schema 存在且可填默认值(schemastery: 直接调用 schema 即校验+填默认)
if (typeof Config !== 'function') throw new Error('Config schema 未导出(schemastery schema 应为函数)');
const defaults = Config({});
if (defaults.completeThreshold !== 0.96 || defaults.tol !== 2) throw new Error(`schema 默认值异常: ${JSON.stringify(defaults)}`);
console.log('Config schema defaults ✓');

// 2) 越界值必须在校验期失败(max 1)
let threw = false;
try { Config({ completeThreshold: 5 }); } catch { threw = true; }
if (!threw) throw new Error('completeThreshold > 1 应校验失败');
console.log('Config schema validation ✓');

// 3) apply(ctx, config) 覆盖 runtimeConfig 并反映到 persona 变量
const variables = [];
const ctx = {
  tools: { register() { return () => {}; } },
  systemPrompt: {
    section() {},
    variable(name, provider) { variables.push([name, provider]); },
  },
};
apply(ctx, { completeThreshold: 0.9, tol: 3, weights: { struct: 0.5 } });
if (runtimeConfig.completeThreshold !== 0.9) throw new Error('completeThreshold 覆盖未生效');
if (runtimeConfig.tol !== 3) throw new Error('tol 覆盖未生效');
if (runtimeConfig.weights.struct !== 0.5) throw new Error('weights.struct 覆盖未生效');
const tv = variables.filter(([n]) => n === 'COMPLETE_THRESHOLD').pop();
if (!tv || String(tv[1]({})) !== '0.9') throw new Error('persona 变量未反映 config 覆盖');
console.log('apply(ctx, config) → runtimeConfig → persona ✓');

// 4) applyConfig(undefined) 为无操作(向后兼容 apply(ctx))
applyConfig(undefined);
if (runtimeConfig.completeThreshold !== 0.9) throw new Error('undefined config 不应重置 runtimeConfig');
console.log('config OK ✓');

// 5) systemPrompt.context() 每轮状态快照：state.json 存在时渲染关键状态，缺席时贡献空文本
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ctx-'));
const prevCwd = process.cwd();
process.chdir(tmp);
fs.mkdirSync(path.join(tmp, '.ui-reverse'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.ui-reverse', 'state.json'), JSON.stringify({
  iteration: 7,
  scores: { current: { total: 0.93 }, previous: { total: 0.9 }, delta: 0.03 },
  remainingDifferences: [{ priority: 0, path: 'header.height' }, { priority: 1, description: 'gap 12→16' }],
}));
const contexts = [];
const ctx2 = {
  tools: { register() { return () => {}; } },
  systemPrompt: {
    section() {},
    variable() {},
    context(c) { contexts.push(c); return () => {}; },
  },
};
apply(ctx2, undefined);
const snap = contexts.find((c) => c.name === 'ui-reverse:state-snapshot');
if (!snap) throw new Error('未注册 ui-reverse:state-snapshot context');
const text = snap.text({});
for (const need of ['iteration: 7', 'score: 0.93', 'header.height', 'gap 12→16']) {
  if (!text.includes(need)) throw new Error(`快照缺少 ${need}: ${text}`);
}
if (text.length > 800) throw new Error('快照应保持有界');
fs.rmSync(tmp, { recursive: true, force: true });
process.chdir(prevCwd);
// state 缺席 → 空文本(宿主跳过该 context)
const empty = snap.text({});
if (empty !== '') throw new Error('state 缺席应贡献空文本');
console.log('context state-snapshot ✓');
