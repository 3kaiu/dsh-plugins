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
//     node adapters/restore.mjs verify <truth.png> <render.png> --bp <blueprint.json> [--blocks-truth mT.json] [--blocks-render mR.json] [--session s.json]
//     (成对提供文本块清单即启用块级层 blockMatchRate —— Web 渲染体用 adapters/dom-blocks.mjs 导出)
//   status   查看/推进会话状态(iteration 记账, maxIterations=5 由调用方遵守)
//     node adapters/restore.mjs status --session <s.json>
//   snapshot 蓝图 → 几何参考快照(truth 来源之一: geometry 级, 无需正确实现)
//     node adapters/restore.mjs snapshot <blueprint.json> <out.png> [--scale N]
//
//   restore  确定性状态机推进(V1.5): 依会话给出当前阶段与下一步动作(analyze→implement→correct→done/report)
//     node adapters/restore.mjs restore [design.json] --session <s.json>
//
//   profile  项目扫描 → Target Profile(v4 A-R: 观察与决策分离, 未知=unknown)
//     node adapters/restore.mjs profile <projectDir> [--out p.json] [--styling x] [--framework x]
//   generate 蓝图+profile → contract → 资产 → React tsx + preview.html + .restore-map.json(v4 Phase 2)
//     node adapters/restore.mjs generate <blueprint.json> --project <dir> [--profile p.json] [--assets a.json] [--out subdir]
//
// RestoreSession(d2c 第六节): 单个 JSON 文件即全部状态; 无数据库无队列。
import fs from 'node:fs';
import path from 'node:path';
import { analyzeDesign, verifyScreenshots, evaluateVerify, restoreAdvisor, verifyQualityKey, MAX_ITERATIONS } from './pipeline.mjs';
import {
  renderGeometrySnapshot,
  analyzeProject, resolveProfile, saveProfile, loadProfile,
  planGeneration, resolveAssets, emitReact, emitPreviewHtml, emitTailwindReact,
} from '../dist/index.js';

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
    const r = verifyScreenshots({ truthPng, renderPng, bpPath,
      grid: Number(flag('grid')) || undefined, top: Number(flag('top')) || undefined,
      blocksTruth: flag('blocks-truth') || undefined, blocksRender: flag('blocks-render') || undefined });
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
      // 记账/验收/防退化全部走 pipeline.evaluateVerify 单一实现(V1.5):
      // 质量键 [区域数, 标记占比, diffRatio] 字典序比较(零人为权重); 劣化轮次被拒绝并要求回滚到最佳轮。
      // 矢量字形豁免与状态三分语义同前(completed/correcting/exhausted)。
      const prev = loadSession(sp) || {};
      const d = evaluateVerify(r, prev);
      let bestRec = d.best;
      // 新一轮成为最佳 → 把该轮渲染截图快照进 session 同目录(防退化后的回滚对照物)
      if (JSON.stringify(bestRec.key) === JSON.stringify(verifyQualityKey(r))) {
        try {
          const snapPath = path.join(path.dirname(path.resolve(sp)), `best-render-${d.iteration}.png`);
          fs.copyFileSync(renderPng, snapPath);
          bestRec = { ...bestRec, screenshot: snapPath };
        } catch { /* 存证失败不影响主流程 */ }
      }
      saveSession(sp, {
        status: d.status,
        iteration: d.iteration,
        best: bestRec,
        regressed: d.regressed,
        lastGuidance: d.guidance,
        verification: { screenshot: renderPng, diffRatio: r.pixel.diffRatio, blockMatchRate: r.blocks?.blockMatchRate ?? null },
        phases: { ...(prev.phases || {}), [`verify-${d.iteration}`]: { pixel: r.pixel, blocks: r.blocks, corrections: r.corrections?.corrections } },
      });
      console.log(`\nquality key[clusters/marked/diff]: ${JSON.stringify(verifyQualityKey(r))} — best iter#${bestRec.iteration}`);
      console.log(`session: iteration=${d.iteration}/${MAX_ITERATIONS} status=${d.status} (${sp})`);
      if (d.regressed) console.log('[REGRESSED] 本轮劣于最佳 —— 按下方指引先回滚再局部重改');
      for (const g of d.guidance) console.log('· ' + g);
    }
    // 局部修复辅助(W3): 差异区域 × 渲染文本块交叉引用 —— LLM 直接按文本定位代码段
    for (const rg of (r.regions?.regions || []).filter((x) => x.domHints?.length).slice(0, 3)) {
      console.log(`定位辅助: 区域(${rg.x},${rg.y} ${rg.width}x${rg.height}) 渲染侧文本块: ` + rg.domHints.map((b) => `"${b.text}"@(${b.x},${b.y})`).join(', '));
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

  if (cmd === 'profile') {
    // v4 A-R: 项目扫描 → Target Profile(观察与决策分离, 未知=unknown)
    const projectDir = args[1];
    if (!projectDir) { console.error('用法: restore.mjs profile <projectDir> [--out profile.json] [--styling x] [--framework x] [--assetDir dir]'); process.exit(1); }
    const r = analyzeProject(projectDir, {
      overrides: {
        framework: flag('framework'), language: flag('language'),
        styling: flag('styling'), build: flag('build'), assetDir: flag('assetDir'),
      },
    });
    const out = flag('out') || path.join(projectDir, 'restore.profile.json');
    saveProfile(r.profile, out);
    console.log(`Target Profile → ${out}`);
    for (const k of ['framework', 'language', 'styling', 'build']) {
      const d = r.profile.decisions[k] || {};
      console.log(`  ${k}: ${d.chosen} (${d.because}, conf=${d.confidence})`);
    }
    console.log(`  assetDir: ${r.profile.assetDir} | componentLibraries: ${r.profile.componentLibraries.join(', ') || '(无)'}`);
    return;
  }

  if (cmd === 'generate') {
    // v4 Phase 2: blueprint + profile → 契约决策 → 资产解析 → React tsx + preview.html + restore-map
    const bpPath = args[1];
    const projectDir = flag('project');
    if (!bpPath || !projectDir) { console.error('用法: restore.mjs generate <blueprint.json> --project <dir> [--profile p.json] [--assets assets.json] [--out subdir] [--base-name X] [--serializer inline|tailwind]'); process.exit(1); }
    const bp = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
    const profile = flag('profile') ? loadProfile(flag('profile')) : resolveProfile({ framework: [], language: [], styling: [], build: [], componentLibraries: [], entry: {} });
    const plan = planGeneration(bp, profile);
    const assetsPath = flag('assets');
    const assets = resolveAssets(bp, plan, {
      assetsExport: assetsPath ? JSON.parse(fs.readFileSync(assetsPath, 'utf8')) : { vectors: [], images: [] },
      assetDir: profile.assetDir,
      projectDir, // 落盘已解析资产
    });
    const outDir = path.join(projectDir, flag('out') || 'restore');
    const baseName = flag('base-name') || 'Restore';
    const serializer = flag('serializer') || (profile.styling === 'tailwind' ? 'tailwind' : 'inline')
    const reactOut = serializer === 'tailwind' ? emitTailwindReact(bp, plan, assets, profile, { baseName }) : emitReact(bp, plan, assets, profile, { baseName });
    const htmlOut = emitPreviewHtml(bp, plan, assets, profile, {});
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of [...reactOut.files, ...htmlOut.files]) {
      const p = path.join(outDir, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
    }
    const mapPath = path.join(outDir, '.restore-map.json');
    fs.writeFileSync(mapPath, JSON.stringify({ ...reactOut.map, preview: htmlOut.map }, null, 1));
    // 资产违约摘要(missing=占位+违约, 禁止近似替代)
    const miss = (assets.assets || []).filter((a) => a.status === 'missing');
    console.log(`generate → ${outDir}: ${reactOut.componentName}.tsx(${serializer}) + preview.html + .restore-map.json (contract ${plan.items.length}, 资产 ${assets.summary.resolved}/${assets.summary.total})`);
    if (miss.length) console.log(`! 资产违约 ${miss.length} 处(几何占位, 禁止近似替代): ` + miss.slice(0, 5).map((a) => `${a.id}:${a.key}`).join(', ') + (miss.length > 5 ? ' ...' : ''));
    if (plan.warnings.length) console.log(`! contract 警告 ${plan.warnings.length} 条(首条: ${plan.warnings[0]})`);
    return;
  }

  if (cmd === 'status') {
    const sp = flag('session');
    if (!sp) { console.error('用法: restore.mjs status --session <s.json>'); process.exit(1); }
    console.log(fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8') : `会话不存在: ${sp}`);
    return;
  }

  if (cmd === 'restore') {
    // V1.5 编排器入口: 与 MCP ui_restore_run(mode=restore) 同一语义 —— 只推进状态机, 不内置 LLM
    const sp = flag('session');
    if (!sp) { console.error('用法: restore.mjs restore [design.json] --session <s.json>'); process.exit(1); }
    let s = loadSession(sp);
    // 位置参数只在首个参数且非旗标时视为 design.json(本文件 flag() 不消费参数值, 防止把 --session 的值误当设计稿)
    const designPath = args[1] && !String(args[1]).startsWith('--') ? args[1] : null;
    if (!s?.phases?.analyze && designPath) {
      const r = await analyzeDesign(designPath, { outDir: flag('dir') || path.dirname(designPath) });
      saveSession(sp, { status: 'analyzed', source: { designPath }, phases: { ...(loadSession(sp)?.phases || {}), analyze: r.summary }, artifacts: r.files });
      console.log(`[analyze 完成] 门禁: 契约 ${r.summary.gates.contract} | 几何 ${r.summary.gates.geometry} | 样式 ${r.summary.gates.style} | 真值 ${r.summary.gates.truth}`);
      s = loadSession(sp);
    }
    const adv = restoreAdvisor(s);
    console.log(`恢复点: phase=${adv.phase} (status=${s?.status || 'none'}, iteration=${s?.iteration || 0}/${MAX_ITERATIONS})`);
    if (s?.best) console.log(`best: iter#${s.best.iteration} key=${JSON.stringify(s.best.key)}${s.best.screenshot ? ` screenshot=${s.best.screenshot}` : ''}`);
    console.log('下一步:');
    for (const a of adv.actions) console.log(' · ' + a);
    return;
  }

  console.error('用法: restore.mjs <analyze|verify|snapshot|restore|status|profile|generate> ...');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
