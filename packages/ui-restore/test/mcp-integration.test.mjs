// MCP 工具面集成测试: 以真实宿主方式(spawn dist/mcp-server.js + stdio JSON-RPC)
// 走完 10 个工具的调用链。此前工具面零集成覆盖 —— confineTo 运行时崩溃
// (ui_restore_generate 一调即崩, 2026-08-29 修复)正是从这条盲区漏出去的;
// 本测试落位后, "LLM 实际会怎么调"的整条链路有了回归网。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'dist', 'mcp-server.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`✓ ${label}`); } else { fail++; console.log(`✗ ${label}`); } };

// ---- 工作区(收容根 = 临时目录, 经 UI_RESTORE_ROOT 显式钉住, 与宿主部署同构) ----
const ws = mkdtempSync(join(tmpdir(), 'mcp-it-'));
mkdirSync(join(ws, 'project'), { recursive: true });
writeFileSync(join(ws, 'project', 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { react: '^18.0.0' } }));

// 最小设计稿(MasterGo 同类导出形态): 背景 + 标题(文本) + 卡片(阴影)
const design = {
  meta: { canvas: { width: 375, height: 812 } },
  sections: [
    { id: 'bg', name: '背景', type: 'LAYER', x: 0, y: 0, width: 375, height: 812, dsl: { styles: {}, nodes: [{ type: 'LAYER', id: 'bg', name: '背景', layoutStyle: { width: 375, height: 812, relativeX: 0, relativeY: 0 }, _color: '#F6F7FB' }] } },
    { id: 'nb', name: '标题', type: 'FRAME', x: 0, y: 44, width: 375, height: 44, dsl: { styles: {}, rowTexts: [{ text: '词书' }], nodes: [{ type: 'TEXT', id: 't1', name: '标题', layoutStyle: { width: 80, height: 24, relativeX: 20, relativeY: 10 }, text: '词书' }] } },
    { id: 'card', name: '容器', type: 'FRAME', x: 16, y: 120, width: 343, height: 120, dsl: { styles: {}, nodes: [{ type: 'FRAME', id: 'card', name: '容器', layoutStyle: { width: 343, height: 120, relativeX: 0, relativeY: 0 }, effect: 'box-shadow' }] } },
  ],
};
writeFileSync(join(ws, 'design.json'), JSON.stringify(design));

// ---- MCP stdio 客户端(换行分隔 JSON-RPC, 与 SDK StdioServerTransport 对齐) ----
const child = spawn('node', [SERVER], {
  cwd: ws,
  env: { ...process.env, UI_RESTORE_ROOT: ws },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {}); // 服务器日志不污染断言输出

let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 非 JSON 行忽略 */ }
  }
});

function request(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时: ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const call = async (name, args) => {
  const m = await request('tools/call', { name, arguments: args });
  const text = (m.result?.content || []).map((c) => c.text).join('\n');
  return { isError: m.result?.isError === true, text };
};

// ---- 握手 ----
const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'it', version: '0.0.0' } });
ok('initialize 握手', !!init.result?.serverInfo);
notify('notifications/initialized');

// ---- tools/list: 10 工具全注册 ----
const list = await request('tools/list', {});
const names = (list.result?.tools || []).map((t) => t.name);
for (const n of ['ui_restore_run', 'ui_restore_blueprint', 'ui_restore_verify', 'ui_restore_region', 'ui_restore_diff', 'ui_restore_tokens', 'ui_restore_profile', 'ui_restore_generate', 'ui_restore_gate', 'ui_restore_merge'])
  ok(`tools/list 含 ${n}`, names.includes(n));
ok('工具总数 = 10', names.length === 10);

// ---- blueprint: 设计稿 → 蓝图 ----
const bp = await call('ui_restore_blueprint', { design_path: join(ws, 'design.json'), out_dir: join(ws, 'artifacts') });
ok('ui_restore_blueprint 出蓝图', !bp.isError && bp.text.includes('blueprint:'));
const bpPath = (bp.text.match(/blueprint: (\S+\.blueprint\.json)/) || [])[1];
ok('蓝图路径可解析且落盘', !!bpPath && existsSync(bpPath));

// ---- run analyze(+session 记账) ----
const session = join(ws, 'session.json');
const ra = await call('ui_restore_run', { design_path: join(ws, 'design.json'), out_dir: join(ws, 'artifacts'), session_path: session });
ok('run analyze 四闸摘要', !ra.isError && ra.text.includes('门禁:'));
ok('session 落盘且含 analyze', existsSync(session) && !!JSON.parse(readFileSync(session, 'utf8')).phases?.analyze);

// ---- 真值/渲染截图(几何快照同源, 同图 → diffRatio 0) ----
const { renderGeometrySnapshot } = await import('../dist/index.js');
const bpJson = JSON.parse(readFileSync(bpPath, 'utf8'));
const snap = renderGeometrySnapshot(bpJson, { scale: 1 });
writeFileSync(join(ws, 'truth.png'), snap.png);
writeFileSync(join(ws, 'render.png'), snap.png);

// ---- run verify: 迭代记账 + 防退化 ----
const rv = await call('ui_restore_run', { truth_png: join(ws, 'truth.png'), render_png: join(ws, 'render.png'), blueprint_path: bpPath, session_path: session });
ok('run verify 指标+记账链路', !rv.isError && rv.text.includes('diffRatio:') && rv.text.includes('session: iteration='));
ok('同图 verify 无 REGRESSED', !rv.text.includes('[REGRESSED]'));

// ---- run restore: 确定性状态机推进 ----
const rr = await call('ui_restore_run', { session_path: session });
ok('run restore 恢复点', !rr.isError && rr.text.includes('恢复点:'));

// ---- region / verify / diff / tokens ----
const rg = await call('ui_restore_region', { blueprint_path: bpPath, rect: '0,0,375,44' });
ok('ui_restore_region 下钻', !rg.isError && rg.text.includes('nodes'));
const vf = await call('ui_restore_verify', { blueprint_path: bpPath });
ok('ui_restore_verify 契约', !vf.isError && vf.text.includes('contract'));
const df = await call('ui_restore_diff', { truth_png: join(ws, 'truth.png'), render_png: join(ws, 'render.png'), blueprint_path: bpPath });
ok('ui_restore_diff 像素+区域', !df.isError && df.text.includes('diffRatio'));
const tk = await call('ui_restore_tokens', { blueprint_path: bpPath });
ok('ui_restore_tokens 出 token', !tk.isError && tk.text.length > 10);

// ---- profile ----
const pf = await call('ui_restore_profile', { project_dir: join(ws, 'project') });
ok('ui_restore_profile 画像', !pf.isError && pf.text.includes('profile'));

// ---- generate(confineTo 回归: 修复前一调即崩) ----
const gen = await call('ui_restore_generate', { blueprint_path: bpPath, project_dir: join(ws, 'project') });
ok('ui_restore_generate 成功(confineTo 回归)', !gen.isError);
ok('generate 产物落盘', existsSync(join(ws, 'project', 'restore')) && existsSync(join(ws, 'project', 'restore', '.restore-map.json')));

// ---- gate ----
const gt = await call('ui_restore_gate', { truth_png: join(ws, 'truth.png'), render_png: join(ws, 'render.png'), blueprint_path: bpPath });
ok('ui_restore_gate 三闸', !gt.isError && gt.text.includes('gate'));

// ---- merge ----
const mg = await call('ui_restore_merge', { project_dir: join(ws, 'project') });
ok('ui_restore_merge 合入', !mg.isError && mg.text.includes('written'));

// ---- 负例: 路径越界必须拒(收容正典, fail closed) ----
const esc = await call('ui_restore_blueprint', { design_path: join(ws, '..', '..', 'etc', 'passwd') });
ok('越界路径拒收(isError)', esc.isError === true);

child.kill();
rmSync(ws, { recursive: true, force: true });

console.log(`\nmcp-integration: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
console.log('mcp-integration OK ✓');
