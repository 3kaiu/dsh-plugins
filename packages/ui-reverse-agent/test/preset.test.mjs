import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 1. preset 目录存在
const presetDir = path.join(root, 'preset', 'ui-reverse');
if (!fs.existsSync(presetDir)) throw new Error(`preset missing: ${presetDir}`);
console.log('preset dir exists', presetDir);
// 2. 必需文件
for (const f of ['preset.yml', 'agent.cordis.yml', 'prompt.md']) {
  const p = path.join(presetDir, f);
  if (!fs.existsSync(p)) throw new Error(`preset file missing: ${f}`);
  const txt = fs.readFileSync(p, 'utf8');
  if (txt.trim().length < 10) throw new Error(`${f} too short`);
  console.log(`preset/${f} ok (${txt.length} bytes)`);
}
// 3. agent.cordis.yml 需含 isolate（browser/devServer 隔离）与 dsh-ui-reverse-agent
const cordis = fs.readFileSync(path.join(presetDir, 'agent.cordis.yml'), 'utf8');
if (!cordis.includes('dsh-ui-reverse-agent')) throw new Error('agent.cordis.yml 缺少 dsh-ui-reverse-agent');
if (!cordis.includes('isolate')) throw new Error('agent.cordis.yml 缺少 isolate 配置');
if (!cordis.includes('dsh-layout-infer')) throw new Error('agent.cordis.yml 缺少 dsh-layout-infer');
console.log('agent.cordis.yml isolate ✓');
// 4. preset.yml 需含 id/description
const presetYml = fs.readFileSync(path.join(presetDir, 'preset.yml'), 'utf8');
if (!presetYml.includes('ui-reverse')) throw new Error('preset.yml 缺少 id');
console.log('preset.yml ok ✓');
// 5. prompt.md 需含 Preset 特有章节（事实来源/反 Hack/完成条件）
const prompt = fs.readFileSync(path.join(presetDir, 'prompt.md'), 'utf8');
for (const key of ['事实来源', '反 Hack 禁令', '完成条件']) {
  if (!prompt.includes(key)) throw new Error(`prompt.md 缺少章节: ${key}`);
}
console.log('prompt.md sections ✓');
// 6. skills/ui-restore/SKILL.md 存在且含信号分级
const skillPath = path.join(root, 'skills', 'ui-restore', 'SKILL.md');
if (!fs.existsSync(skillPath)) throw new Error(`skill missing: ${skillPath}`);
const skill = fs.readFileSync(skillPath, 'utf8');
if (!skill.includes('信号分级') || !skill.includes('P0')) throw new Error('SKILL.md 缺少核心章节');
console.log('skills/ui-restore/SKILL.md ok ✓');
// 6b. workflow.yml 存在且含 ralph
const wfPath = path.join(root, 'preset', 'ui-reverse', 'workflow.yml');
if (!fs.existsSync(wfPath)) throw new Error(`workflow missing: ${wfPath}`);
const wf = fs.readFileSync(wfPath, 'utf8');
if (!wf.includes('ralph') || !wf.includes('fanout_evaluate')) throw new Error('workflow.yml 缺少 ralph/fanout');
console.log('preset/ui-reverse/workflow.yml ok ✓');
// 7. package.json files 需含 preset/skills
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!pkg.files.includes('preset') || !pkg.files.includes('skills')) throw new Error('package.json files 缺少 preset/skills');
console.log('package.json files ✓');
console.log('preset OK ✓');
