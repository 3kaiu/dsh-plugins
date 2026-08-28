import { stateRead, stateUpdate, syncGoalsAndTodo } from "../dist/index.js";
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-goals-'));
const p = path.join(dir, 'state.json');
// 初始无 goals/todo
let r = stateRead({ statePath: p });
if (r.exists) throw new Error('初始应不存在');
// 写入带剩余差异的 state，应自动落盘 goals.json/todo.json/todo.md
const diffs = [
  { path: 'header', prop: 'height', expected: 80, actual: 64, delta: 16, priority: 'P0', confidence: 0.9 },
  { path: 'main > .card-grid', prop: 'gap', expected: 24, actual: 16, delta: 8, priority: 'P1' },
  { path: 'footer', prop: 'color', expected: '#111', actual: '#333', delta: 1, priority: 'P2' },
];
const u1 = await stateUpdate({ remainingDifferences: diffs, scores: { current: { total: 0.82 } } }, { statePath: p, historyNote: 'with diffs' });
console.log('stateUpdate with diffs', u1.state.remainingDifferences.length);
const goalsPath = path.join(dir, 'goals.json');
const todoPath = path.join(dir, 'todo.json');
const todoMd = path.join(dir, 'todo.md');
for (const f of [goalsPath, todoPath, todoMd]) {
  if (!fs.existsSync(f)) throw new Error(`应生成 ${path.basename(f)}`);
}
const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
if (goals.goals.length !== 3) throw new Error(`goals 应 3 条得 ${goals.goals.length}`);
if (goals.goals[0].priority !== 'P0' || goals.goals[0].status !== 'in_progress') throw new Error('首条应 P0 in_progress');
console.log('goals.json', goals.goals.map(g=>g.id).join(','));
const todos = JSON.parse(fs.readFileSync(todoPath, 'utf8'));
if (todos.todos.length < 3) throw new Error('todos 应 >=3');
console.log('todo.json', todos.todos.length);
const md = fs.readFileSync(todoMd, 'utf8');
if (!md.includes('header') || !md.includes('P0')) throw new Error('todo.md 缺少内容');
console.log('todo.md ok');
// 追加一条已解决，验证 todos 包含 completed
const u2 = await stateUpdate({ resolvedDifferences: [{ path: 'header', prop: 'height', iteration: 1 }], scores: { current: { total: 0.85 } } }, { statePath: p });
const todos2 = JSON.parse(fs.readFileSync(todoPath, 'utf8'));
if (!todos2.todos.some(t => t.status === 'completed')) throw new Error('应含 completed todo');
console.log('completed todo ✓');
// syncGoalsAndTodo 直接调用
const sync = syncGoalsAndTodo(u2.state, { statePath: p });
if (!sync.goalsPath || !sync.todoPath) throw new Error('sync 返回路径缺失');
console.log('state-goals OK ✓');
