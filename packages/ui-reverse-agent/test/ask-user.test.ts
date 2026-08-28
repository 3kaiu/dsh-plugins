// ask-user 契约测试: 探测与调用必须符合 dsh-user-questions 的
// ctx.userQuestions.ask({questions:[{id,options:[{label}]}]}) → {answers:{[id]:{selected,custom}}}
// （此前探测 ctx.approval 并传 {question,options,kind}，与真实服务契约三重不匹配。）
import { detectAskUser, decideWithAsk } from "../dist/index.js";

// 1) 宿主无 userQuestions → fallback
let r = await decideWithAsk({}, { type: 'sticker', options: ['A', 'B'], fallback: 'B' });
if (r.decision !== 'B' || r.source !== 'fallback') throw new Error(`无服务应 fallback, got ${JSON.stringify(r)}`);
if (detectAskUser({}).available) throw new Error('空 ctx 不应判定可用');
console.log('✓ 无服务 fallback');

// 2) 官方契约：questions 数组 + options[{label}]；读 answers[id].selected
let captured = null;
const svc = {
  ask: async (req) => {
    captured = req;
    const q = req.questions[0];
    return { answers: { [q.id]: { selected: ['使用系统字体栈'] } } };
  },
};
r = await decideWithAsk({ userQuestions: svc }, { type: 'font-missing', detail: '参考字体 PingFang 缺失', options: ['使用系统字体栈', '下载并注册字体'] });
if (r.decision !== '使用系统字体栈' || r.source !== 'ask') throw new Error(`selected 未被读取: ${JSON.stringify(r)}`);
if (!Array.isArray(captured.questions) || !Array.isArray(captured.questions[0].options) || typeof captured.questions[0].options[0] !== 'object')
  throw new Error(`请求形状不符官方契约: ${JSON.stringify(captured)}`);
console.log('✓ ctx.userQuestions.ask 契约 + selected 读取');

// 3) 用户选 Other(custom) → custom 优先于 selected
const svcCustom = { ask: async (req) => ({ answers: { [req.questions[0].id]: { selected: [], custom: '手动指定 Inter' } } }) };
r = await decideWithAsk({ userQuestions: svcCustom }, { type: 'font-missing', options: ['A'] });
if (r.decision !== '手动指定 Inter') throw new Error(`custom 应优先: ${JSON.stringify(r)}`);
console.log('✓ custom 优先');

// 4) font-missing 有 knownConstraints 白名单时不打扰用户
let called = false;
const svcProbe = { ask: async () => { called = true; return { answers: {} }; } };
r = await decideWithAsk({ userQuestions: svcProbe }, { type: 'font-missing', fallback: '系统字体' });
if (called || r.source !== 'knownConstraints') throw new Error('白名单应短路询问');
console.log('✓ knownConstraints 白名单短路');

// 5) 服务抛错 → fallback 而非崩溃
const svcErr = { ask: async () => { throw new Error('NO_PROVIDER'); } };
r = await decideWithAsk({ userQuestions: svcErr }, { type: 'sticker', options: ['X'], fallback: 'X' });
if (r.decision !== 'X' || r.source !== 'fallback') throw new Error(`服务异常应回退: ${JSON.stringify(r)}`);
console.log('✓ 服务异常回退');

console.log('ask-user OK ✓');
