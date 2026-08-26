#!/usr/bin/env node
// restore.mjs — UI Restore Workflow Runner(d2c 规划: restore_ui 主入口的执行体)
//
// 定位: 单入口确定性 Pipeline + 会话状态。不是第二层 LLM Agent —— 实现/修码由调用方(LLM/Agent)完成,
// 本 runner 负责: 分析 → 产物包 → (渲染图就位后)对比 → 修正指令 → 循环状态记账。
//
// 用法:
//   analyze  设计稿 → UI Truth 产物包(四闸门禁)
//     node adapters/restore.mjs analyze <design.json> [--dir out] [--scale 2|auto] [--expect-sections N] [--session s.json]
//   verify   参考图 vs 渲染截图 → 指标 + 差异区域 + 修正指令
//     node adapters/restore.mjs verify <truth.png> <render.png> --bp <blueprint.json> [--session s.json]
//   status   查看/推进会话状态(iteration 记账, maxIterations=5 由调用方遵守)
//     node adapters/restore.mjs status --session <s.json>
//   snapshot 蓝图 → 几何参考快照(truth 来源之一: geometry 级, 无需正确实现)
//     node adapters/restore.mjs snapshot <blueprint.json> <out.png> [--scale N]
//
// RestoreSession(d2c 第六节): 单个 JSON 文件即全部状态; 无数据库无队列。
import fs from 'node:fs';
import path from 'node:path';
import { analyzeDesign, verifyScreenshots } from './pipeline.mjs';
import { renderGeometrySnapshot } from '../dist/index.js';

const MAX_ITERATIONS = 5;
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

function loadSession(p) {
  if (!p) return null;
  if (!fs.existsSync(p)) {
    const s = { createdAt: new Date().toISOString(), iteration: 0, status: 'analyzing', phases: {} };
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 1));
    return s;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveSession(p, patch) {
  const s = loadSession(p) || {};
  Object.assign(s, patch, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(p, JSON.stringify(s, null, 1));
  return s;
}

async function main() {
  if (cmd === 'analyze') {
    const designPath = args[1];
    if (!designPath) { console.error('用法: restore.mjs analyze <design.json> [--dir out] [--scale auto] [--expect-sections N] [--session s.json]'); process.exit(1); }
    const r = await analyzeDesign(designPath, {
      outDir: flag('dir') || undefined,
      scale: flag('scale') || undefined,
      expectSections: flag('expect-sections') || undefined,
    });
    const g = r.summary.gates;
    console.log(`门禁: 契约 ${g.contract} | 几何 ${g.geometry} | 样式 ${g.style} | 真值 ${g.truth}`);
    for (const c of r.lint.checks.filter((c) => c.level === 'WARN' || c.level === 'FAIL')) console.log(`! [${c.level}] ${c.check}: ${c.detail}`);
    console.log(`产物: ${Object.values(r.files).length} 个文件 @ ${r.summary.outDir}`);
    console.log('消费顺序: INDEX 见 checklist.txt(合同) → outline.txt(空间心智+消费指南) → blueprint.json(精确数值)');
    const sp = flag('session');
    if (sp) saveSession(sp, {
      status: 'analyzed',
      source: { designPath },
      phases: { ...(loadSession(sp)?.phases || {}), analyze: r.summary },
      artifacts: r.files,
    });
    return;
  }

  if (cmd === 'verify') {
    const [truthPng, renderPng] = [args[1], args[2]];
    const bpPath = flag('bp');
    if (!truthPng || !renderPng || !bpPath) { console.error('用法: restore.mjs verify <truth.png> <render.png> --bp <blueprint.json> [--grid N] [--top N] [--session s.json]'); process.exit(1); }
    const r = verifyScreenshots({ truthPng, renderPng, bpPath, grid: Number(flag('grid')) || undefined, top: Number(flag('top')) || undefined });
    console.log(JSON.stringify(r.pixel));
    if (r.blocks) console.log('块级层:', JSON.stringify(r.blocks));
    if (r.corrections) {
      console.log(`\n# 修正指令 — ${r.corrections.summary}`);
      for (const line of r.corrections.corrections) console.log(' -', line);
    } else if (r.regions) {
      console.log(JSON.stringify(r.regions.regions?.slice(0, 5)));
    }
    const sp = flag('session');
    if (sp) {
      const s = loadSession(sp) || { phases: {} };
      const iteration = (s.iteration || 0) + 1;
      const zeroDiff = r.pixel.diffRatio === 0 || (r.regions && r.regions.clusterCount === 0);
      const done = iteration >= MAX_ITERATIONS || (r.blocks?.blockMatchRate != null ? r.blocks.blockMatchRate >= 1 : zeroDiff);
      saveSession(sp, {
        status: done ? 'completed' : 'correcting',
        iteration,
        verification: { screenshot: renderPng, diffRatio: r.pixel.diffRatio, blockMatchRate: r.blocks?.blockMatchRate ?? null },
        phases: { ...(s.phases || {}), [`verify-${iteration}`]: { pixel: r.pixel, blocks: r.blocks, corrections: r.corrections?.corrections } },
      });
      console.log(`\nsession: iteration=${iteration}/${MAX_ITERATIONS} status=${done ? 'completed' : 'correcting'} (${sp})`);
    }
    return;
  }

  if (cmd === 'snapshot') {
    // 参考图来源(d2c 第十四节): 蓝图 → 几何参考快照, truth 不再依赖"正确实现"
    const bpPath = args[1];
    const outPng = flag('out') || args[2];
    if (!bpPath || !outPng) { console.error('用法: restore.mjs snapshot <blueprint.json> <out.png> [--scale N] [--background #FFF]'); process.exit(1); }
    const bp = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
    const r = renderGeometrySnapshot(bp, { scale: Number(flag('scale')) || 1, background: flag('background') || undefined });
    fs.mkdirSync(path.dirname(path.resolve(outPng)), { recursive: true });
    fs.writeFileSync(outPng, r.png);
    console.log(`几何快照: ${outPng} (${r.width}x${r.height}) — geometry 级参考: 可检出位置/尺寸/颜色块差异, 不含字形细节`);
    return;
  }

  if (cmd === 'status') {
    const sp = flag('session');
    if (!sp) { console.error('用法: restore.mjs status --session <s.json>'); process.exit(1); }
    console.log(fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8') : `会话不存在: ${sp}`);
    return;
  }

  console.error('用法: restore.mjs <analyze|verify|status> ...');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
