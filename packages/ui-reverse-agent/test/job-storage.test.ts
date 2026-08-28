import { JobDevServer, describeJobSupport } from "../dist/index.js";
import { persistArtifact, retrieveArtifact } from "../dist/index.js";
import { decideWithAsk, buildHeatmapNode } from "../dist/index.js";
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';

console.log('JobDevServer raw fallback');
let j1 = new JobDevServer({ command: 'echo hi', cwd: process.cwd() }, null);
if (j1.mode !== 'raw') throw new Error('null ctx should raw');
let desc = describeJobSupport({});
if (desc.jobs !== false) throw new Error('empty ctx jobs false');
console.log('describeJobSupport', desc);
let j2 = new JobDevServer({ command: 'echo hi' }, { jobs: { run: async () => ({ id: 'j1' }) } });
console.log('JobDevServer jobs mode', j2.opts.command);

// storage fallback (fs-json)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'));
const cwd = process.cwd(); process.chdir(dir);
fs.mkdirSync('.ui-reverse', { recursive: true });
let p1 = await persistArtifact(null, { key: 'ui-reverse:test', value: { a: 1 } });
if (!p1.stored) throw new Error('persist should store via fs-json');
console.log('persist fs-json', p1);
let r1 = await retrieveArtifact(null, 'ui-reverse:test');
if (r1.value?.a !== 1) throw new Error('retrieve failed');
console.log('retrieve fs-json', r1.value);
process.chdir(cwd);

// ask-user fallback
let a1 = await decideWithAsk(null, { type: 'font-missing', detail: 'DIN Pro', options: ['Inter','skip'], fallback: 'Inter' });
if (a1.decision !== 'Inter' || a1.source !== 'knownConstraints') throw new Error('font fallback should knownConstraints');
console.log('decide fallback', a1);
let a2 = await decideWithAsk({}, { type: 'asset-missing', detail: 'logo', options: ['placeholder'], fallback: 'placeholder' });
if (a2.source !== 'fallback') throw new Error('no svc should fallback');
console.log('decide no svc', a2);
// ask-user: 官方 userQuestions 契约（2026-08 前错误探测 ctx.approval + {answer} 回答形状）
let a3 = await decideWithAsk(
  { userQuestions: { ask: async (req) => ({ answers: { [req.questions[0].id]: { selected: ['Inter'] } } }) } },
  { type: 'sticker', detail: 'x', options: ['Inter','skip'], fallback: 'skip' },
);
if (a3.decision !== 'Inter' || a3.source !== 'ask') throw new Error('mock ask should return Inter via userQuestions.ask');
console.log('ask mock', a3);

// heatmap node
let node = buildHeatmapNode({ diffPath: 'diff.png', regionScores: [{ region:'header', ssim:0.8 }], score: { total:0.9 } });
if (node.kind !== 'ui-reverse:diff-heatmap') throw new Error('heatmap kind');
console.log('heatmap node', node.kind);

console.log('job-storage OK ✓');
