#!/usr/bin/env node
// ui-restore CLI — 通用 UI 还原核心的命令行暴露面
//
// 用法:
//   ui-restore build     <design.json> [--dir <outDir>] [--scale 2|auto]  一键产物包(推荐入口)
//   ui-restore blueprint <design.json> [--dir <outDir>] [--scale 2|auto]  蓝图 + outline
//   ui-restore verify    <blueprint.json>                                 校验蓝图契约 + 摘要
//   ui-restore diff      <truth.png> <render.png>                         像素 + 块级(D2C)对比
//   ui-restore regions   <truth.png> <render.png> [--bp <blueprint.json>] diff 区域 → 节点定位
//
// 设计稿输入经 ingestDesignExport 自适应: {meta:{canvas},sections:[...]} / MCP 聚合导出 / 裸 section 数组
import fs from 'node:fs';
import path from 'node:path';
import {
  validateBlueprint, blueprintRegion,
  blueprintToOutline, verifyLayoutTruth, comparePng, blockMetrics, decodePng, diffRegions,
  evaluateGate, computeScore,
} from './dist/index.js';
// 编排逻辑单一来源(审计 P2 收敛): 蓝图构建/产物包/叶子遍历统一走 adapters/pipeline.mjs
import { buildBlueprint, writeArtifactBundle, collectLeaves } from './adapters/pipeline.mjs';

const [, , cmd, ...args] = process.argv;
// 纯函数：不改动 args 数组，仅读取，避免 --help 等场景误改参数表导致目录误建或位置参数错位
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  // 缺值时返回 true（布尔开关语义），否则返回字符串值；不做 splice，保持 args 纯净
  return v == null || String(v).startsWith('--') ? true : v;
};

function printGateSummary(bp, v) {
  console.log('契约校验:', v.ok ? 'PASS' : `FAIL ${JSON.stringify(v.errors.slice(0, 3))}`);
  console.log('几何守恒:', bp.diffReport.verdict);
  console.log('样式守恒:', bp.styleDiffReport?.verdict || 'n/a');
  if (bp.canvas.scale) console.log(`倍率: ${bp.canvas.scale.factor}×(${bp.canvas.scale.source}${bp.canvas.scale.confidence != null ? ` conf=${bp.canvas.scale.confidence}` : ''}) → 已归一逻辑像素`);
  console.log('真值:', bp.truthReport?.verdict, '| pageShell:', bp.pageShell?.archetype || '无');
}

/** 蓝图管线公共段已上移 adapters/pipeline.buildBlueprint —— 本文件只做 CLI 参数搬运 */
async function runBlueprint(designPath) {
  const scaleArg = flag('--scale');
  const expectSections = flag('--expect-sections');
  // scale/expectSections 优先级与原实现一致: CLI 显式参数 > 导出 meta 声明 > 不归一
  const { bp, v, lint } = await buildBlueprint(designPath, {
    scale: scaleArg ?? undefined,
    expectSections: typeof expectSections === 'string' && expectSections !== '' ? Number(expectSections) : undefined,
  });
  return { bp, v, lint };
}

function printLint(lint) {
  for (const c of lint.checks) console.log(`输入体检[${c.level}] ${c.check}: ${c.detail}`);
}

async function main() {
  if (cmd === 'build' || cmd === 'blueprint') {
    const designPath = args[0];
    if (!designPath) { console.error(`用法: ui-restore ${cmd} <design.json> [--dir <outDir>] [--scale 2|auto] [--expect-sections N]`); process.exit(1); }
    const outDir = flag('--dir') || path.dirname(designPath);
    const { bp, v, lint } = await runBlueprint(designPath);
    printLint(lint);
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.basename(designPath).replace(/\.json$/, '');
    printGateSummary(bp, v);

    if (cmd === 'build') {
      // 一键产物包与 workflow/MCP 主入口完全同源(writeArtifactBundle, 含 INDEX.txt 阅读地图)
      const { files } = writeArtifactBundle(bp, v, lint, outDir, base);
      const kb = (n) => `${Math.round(n / 102.4) / 10}KB`;
      for (const f of ['checklist', 'tokens', 'assets', 'index']) console.log(`${f}: ${files[f]} (${kb(fs.statSync(files[f]).size)})`);
    } else {
      const bpPath = path.join(outDir, `${base}.blueprint.json`);
      fs.writeFileSync(bpPath, JSON.stringify(bp));
      fs.writeFileSync(path.join(outDir, `${base}.outline.txt`), blueprintToOutline(bp));
    }
    if (!v.ok) process.exit(1);
    return;
  }
  if (cmd === 'doctor') {
    const designPath = args[0];
    if (!designPath) { console.error('用法: ui-restore doctor <design.json> [--expect-sections N]'); process.exit(1); }
    const expectSections = flag('--expect-sections');
    const raw = JSON.parse(fs.readFileSync(designPath, 'utf8'));
    const lint = lintDesignExport(raw, { expectSections: expectSections ? Number(expectSections) : undefined });
    printLint(lint);
    const fails = lint.checks.filter((c) => c.level === 'FAIL').length;
    console.log(lint.ok ? '输入体检: PASS(可进管线)' : `输入体检: FAIL(${fails} 项必须修复)`);
    process.exit(lint.ok ? 0 : 1);
  }
  if (cmd === 'verify') {
    const bpPath = args[0];
    if (!bpPath) { console.error('用法: ui-restore verify <blueprint.json>'); process.exit(1); }
    const bp = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
    const v = validateBlueprint(bp);
    console.log('契约校验:', v.ok ? 'PASS' : `FAIL\n${v.errors.join('\n')}`);
    const t = verifyLayoutTruth(bp);
    if (t) console.log('真值:', JSON.stringify({ verdict: t.verdict, maxDelta: t.maxDelta, matched: `${t.childrenMatched}/${t.childrenChecked}` }));
    process.exit(v.ok ? 0 : 1);
  }
  if (cmd === 'diff') {
    const [truthPng, renderPng] = args;
    if (!truthPng || !renderPng) { console.error('用法: ui-restore diff <truth.png> <render.png> [--blocks <mTruth.json> <mRender.json>] [--canvas WxH]'); process.exit(1); }
    const manifest = flag('--blocks');
    const canvasFlag = flag('--canvas');
    const r = comparePng(fs.readFileSync(truthPng), fs.readFileSync(renderPng));
    console.log('像素层:', JSON.stringify({ diffPixels: r.diffPixels, diffRatio: r.diffRatio }));
    if (manifest) {
      const files = manifest.split(',');
      const [mT, mR] = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
      const [W, H] = (canvasFlag || '375x812').split('x').map(Number);
      const imgT = decodePng(fs.readFileSync(truthPng));
      const imgR = decodePng(fs.readFileSync(renderPng));
      const b = blockMetrics(mT, mR, { designImg: imgT, renderImg: imgR, canvasWidth: W, canvasHeight: H });
      console.log('块级层:', JSON.stringify({ blockMatchRate: b.blockMatchRate, matchedPairs: b.matchedPairs, positionSimilarity: b.positionSimilarity, colorSimilarity: b.colorSimilarity, avgTextSimilarity: b.avgTextSimilarity }));
    }
    const out = flag('--out');
    if (out) fs.writeFileSync(out, r.diffPng);
    return;
  }
  if (cmd === 'regions') {
    const [truthPng, renderPng] = args;
    if (!truthPng || !renderPng) { console.error('用法: ui-restore regions <truth.png> <render.png> [--bp <blueprint.json>] [--grid 24] [--top 5]'); process.exit(1); }
    const bpFlag = flag('--bp');
    let nodes;
    if (bpFlag) nodes = collectLeaves(JSON.parse(fs.readFileSync(bpFlag, 'utf8')));
    const gridN = Number(flag('--grid')) || undefined;
    const topN = Number(flag('--top')) || undefined;
    const r = diffRegions(fs.readFileSync(truthPng), fs.readFileSync(renderPng), { nodes, grid: gridN, top: topN });
    console.log(JSON.stringify(r, null, 1));
    if (bpFlag) {
      const { diffToCorrections } = await import('./dist/index.js');
      const c = diffToCorrections(JSON.parse(fs.readFileSync(bpFlag, 'utf8')), r);
      if (c) {
        console.log('\n# 修正指令(按严重度逐条核对)');
        console.log(c.summary);
        for (const line of c.corrections) console.log(' -', line);
      }
    }
    return;
  }
  if (cmd === 'region') {
    const designPath = args[0];
    const rectFlag = flag('--rect');
    const idsFlag = flag('--ids');
    if (!designPath || (!rectFlag && !idsFlag)) { console.error('用法: ui-restore region <design.json> --rect x,y,width,height | --ids id1,id2 [--dir <outDir>]'); process.exit(1); }
    const { bp } = await runBlueprint(designPath);
    const sel = rectFlag
      ? (() => { const [x, y, width, height] = rectFlag.split(',').map(Number); return { x, y, width, height }; })()
      : { ids: idsFlag.split(',').map((s) => s.trim()) };
    const region = blueprintRegion(bp, sel);
    if (!region) { console.error('区域下钻失败: 非法参数'); process.exit(1); }
    const outDir = flag('--dir') || path.dirname(designPath);
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.basename(designPath).replace(/\.json$/, '');
    const tag = rectFlag ? `r${Math.round(sel.x)}_${Math.round(sel.y)}` : 'ids';
    const outFile = path.join(outDir, `${base}.region-${tag}.json`);
    fs.writeFileSync(outFile, JSON.stringify(region));
    console.log(`区域下钻: ${region.count} 节点 → ${outFile}`);
    for (const n of region.nodes) console.log(`  ${n.type} ${n.name || n.id} @(${n.bounds?.x},${n.bounds?.y})`);
    return;
  }
  if (cmd === 'profile') {
    const projectDir = args[0];
    if (!projectDir) { console.error('用法: ui-restore profile <projectDir> [--out profile.json] [--styling x] [--framework x]'); process.exit(1); }
    const { analyzeProject, saveProfile } = await import('./dist/index.js');
    const overrides = { framework: flag('--framework'), language: flag('--language'), styling: flag('--styling'), build: flag('--build'), assetDir: flag('--assetDir') };
    for (const k of Object.keys(overrides)) if (overrides[k] == null) delete overrides[k];
    const r = analyzeProject(projectDir, { overrides });
    const out = flag('--out') || path.join(projectDir, 'restore.profile.json');
    saveProfile(r.profile, out);
    console.log(`Target Profile → ${out}`);
    for (const k of ['framework','language','styling','build']) {
      const d = r.profile.decisions[k]||{}; console.log(`  ${k}: ${d.chosen} (${d.because}, conf=${d.confidence})`);
    }
    console.log(`  assetDir: ${r.profile.assetDir} | libs: ${r.profile.componentLibraries.join(', ')||'(无)'}`);
    return;
  }
  if (cmd === 'generate') {
    const bpPath = args[0];
    const projectDir = flag('--project');
    if (!bpPath || !projectDir) { console.error('用法: ui-restore generate <blueprint.json> --project <dir> [--profile <p.json>] [--assets <a.json>] [--out subdir] [--base-name X] [--serializer inline|tailwind|vue|flutter|miniprogram]'); process.exit(1); }
    const { loadProfile, resolveProfile, planGeneration, resolveAssets, emitPreviewHtml, ensureBuiltins, resolveAdapterAsync } = await import('./dist/index.js');
    const bp = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
    const profile = flag('--profile') ? loadProfile(flag('--profile')) : (await import('./dist/index.js')).analyzeProject(projectDir).profile;
    const plan = planGeneration(bp, profile);
    const assetsPath = flag('--assets');
    const assets = resolveAssets(bp, plan, { assetsExport: assetsPath ? JSON.parse(fs.readFileSync(assetsPath,'utf8')) : { vectors:[], images:[] }, assetDir: profile.assetDir, projectDir });
    const outDir = path.join(projectDir, flag('--out') || 'restore');
    const baseName = flag('--base-name') || 'Restore';
    await ensureBuiltins()
    const adapter = await resolveAdapterAsync(profile, flag('--serializer') || undefined)
    const reactOut = adapter.emit(bp, plan, assets, profile, { baseName })
    const serializer = adapter.id
    const htmlOut = emitPreviewHtml(bp, plan, assets, profile, {});
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of [...reactOut.files, ...htmlOut.files]) {
      const p = path.join(outDir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content);
    }
    // DOM Map: 合并主图与预览 selector(同源 1:1)
    const mapPath = path.join(outDir, '.restore-map.json');
    fs.writeFileSync(mapPath, JSON.stringify({ ...reactOut.map, preview: htmlOut.map }, null, 1));
    const miss = (assets.assets||[]).filter((a)=>a.status==='missing');
    const ext = serializer === 'vue' ? '.vue' : serializer === 'flutter' ? '.dart' : serializer === 'miniprogram' ? '.wxml' : '.tsx'
    console.log(`generate → ${outDir}: ${reactOut.componentName}${ext}(${serializer}) + preview.html + .restore-map.json (contract ${plan.items.length}, 资产 ${assets.summary.resolved}/${assets.summary.total})`);
    if (miss.length) console.log(`! 资产违约 ${miss.length} 处: `+ miss.slice(0,5).map((a)=>`${a.id}:${a.key}`).join(', '));
    if (plan.warnings.length) console.log(`! warnings: ${plan.warnings[0]}`);
    return;
  }
  if (cmd === 'merge') {
    const projectDir = args[0];
    const fromDir = flag('--from') || flag('--src');
    if (!projectDir) { console.error('用法: ui-restore merge <projectDir> [--from <generatedDir>] [--on-conflict rename|skip|overwrite]'); process.exit(1); }
    const { mergeIntoProject, canMerge } = await import('./dist/index.js');
    const srcDir = fromDir ? path.resolve(fromDir) : path.join(projectDir, 'restore');
    if (!fs.existsSync(srcDir)) { console.error(`生成目录不存在: ${srcDir}`); process.exit(1); }
    const check = canMerge(projectDir);
    if (!check.ok) console.log(`! 预检: ${check.reasons.join('; ')}`);
    const files = [];
    const walk = (dir, base='')=>{
      for(const e of fs.readdirSync(dir, {withFileTypes:true})){
        const rel = path.join(base, e.name);
        const abs = path.join(dir, e.name);
        if(e.isDirectory()) walk(abs, rel);
        else files.push({ path: rel, content: fs.readFileSync(abs,'utf8') });
      }
    };
    walk(srcDir);
    const res = mergeIntoProject(projectDir, files, { onConflict: flag('--on-conflict') || 'rename' });
    console.log(`merge → ${res.written.length} 文件: ${res.written.map(w=> `${w.path}(${w.action})`).join(', ')}`);
    if(res.entrySuggestion) console.log(res.entrySuggestion);
    return;
  }
  if (cmd === 'gate') {
    const [truthPng, renderPng] = args;
    const bpPath = flag('--bp');
    if (!truthPng || !renderPng) { console.error('用法: ui-restore gate <truth.png> <render.png> [--bp <blueprint.json>] [--assets <assets.json>]'); process.exit(1); }
    const bp = bpPath ? JSON.parse(fs.readFileSync(bpPath,'utf8')) : null;
    const pixel = comparePng(fs.readFileSync(truthPng), fs.readFileSync(renderPng));
    let regions = null;
    if (bp) {
      const leaves = collectLeaves(bp);
      regions = diffRegions(fs.readFileSync(truthPng), fs.readFileSync(renderPng), { nodes: leaves });
    }
    const contract = bp ? validateBlueprint(bp) : null;
    let assets = null;
    const assetsPath = flag('--assets');
    if (assetsPath && fs.existsSync(assetsPath)) {
      const raw = JSON.parse(fs.readFileSync(assetsPath,'utf8'));
      const list = raw.vectors || raw.assets || [];
      assets = { summary: { missing: list.filter((v)=>!v.svg && !v.path && !v.src).length, total: list.length } };
    }
    const gate = evaluateGate({ pixel, regions, blueprint: bp, contract, assets });
    const score = computeScore({ pixel, regions, blueprint: bp, contract, assets });
    console.log(`gate: ${gate.verdict} | score: ${score.score}`);
    for (const r of gate.reasons) console.log(` ! ${r}`);
    console.log(JSON.stringify({ gate, score }, null, 1));
    process.exit(gate.pass ? 0 : 2);
  }
  console.error('用法: ui-restore <build|blueprint|doctor|verify|diff|regions|region|profile|generate|gate|merge> ...');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
