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
  generateCodeBlueprint, initTextMetrics, validateBlueprint,
  blueprintToOutline, verifyLayoutTruth, comparePng, blockMetrics, decodePng,
  ingestDesignExport, lintDesignExport, restorationChecklist, checklistToText, extractDesignTokens, diffRegions,
} from './dist/index.js';

const [, , cmd, ...args] = process.argv;
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v || true;
};

function printGateSummary(bp, v) {
  console.log('契约校验:', v.ok ? 'PASS' : `FAIL ${JSON.stringify(v.errors.slice(0, 3))}`);
  console.log('几何守恒:', bp.diffReport.verdict);
  console.log('样式守恒:', bp.styleDiffReport?.verdict || 'n/a');
  if (bp.canvas.scale) console.log(`倍率: ${bp.canvas.scale.factor}×(${bp.canvas.scale.source}${bp.canvas.scale.confidence != null ? ` conf=${bp.canvas.scale.confidence}` : ''}) → 已归一逻辑像素`);
  console.log('真值:', bp.truthReport?.verdict, '| pageShell:', bp.pageShell?.archetype || '无');
}

/** 蓝图管线公共段: 读稿 → 输入体检 → 归一 → 蓝图 → 契约校验 */
async function runBlueprint(designPath) {
  const scaleArg = flag('--scale');
  await initTextMetrics();
  const raw = JSON.parse(fs.readFileSync(designPath, 'utf8'));
  // scale 优先级: CLI 显式参数 > 导出 meta 声明 > 不归一
  const declaredScale = raw?.meta?.scale ?? raw?.meta?.canvas?.scale;
  const expectSections = flag('--expect-sections');
  const lint = lintDesignExport(raw, { expectSections: expectSections ? Number(expectSections) : undefined });
  const { canvas, styles, nodes } = ingestDesignExport(raw);
  const bp = generateCodeBlueprint({ canvas, nodes, styles, scale: scaleArg ?? declaredScale ?? null });
  return { bp, v: validateBlueprint(bp), raw, lint };
}

function printLint(lint) {
  for (const c of lint.checks) console.log(`输入体检[${c.level}] ${c.check}: ${c.detail}`);
}

/** 收集蓝图全部叶子节点(diffRegions 的候选映射输入) */
function leafNodesOf(bp) {
  const leaves = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (!Array.isArray(n.children) || n.children.length === 0) leaves.push(n);
    else for (const c of n.children) walk(c);
  };
  for (const r of [...(bp.tree || []), ...(bp.floatings || [])]) walk(r);
  return leaves.map((n) => ({ id: n.id, name: n.name || '', text: typeof n.text === 'string' ? n.text : undefined, bounds: n.bounds }));
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
    const files = {};
    files.blueprint = path.join(outDir, `${base}.blueprint.json`);
    files.outline = path.join(outDir, `${base}.outline.txt`);
    fs.writeFileSync(files.blueprint, JSON.stringify(bp));
    fs.writeFileSync(files.outline, blueprintToOutline(bp));
    printGateSummary(bp, v);

    if (cmd === 'build') {
      // 一键产物包: 分层产物 + 资源骨架 + 索引 —— LLM 按序消费, 不必自行编排多次调用
      const cl = restorationChecklist(bp);
      cl.gates.contract = v.ok ? 'PASS' : 'FAIL';
      files.checklistJson = path.join(outDir, `${base}.checklist.json`);
      files.checklist = path.join(outDir, `${base}.checklist.txt`);
      files.tokens = path.join(outDir, `${base}.tokens.json`);
      files.assets = path.join(outDir, `${base}.assets.json`);
      files.index = path.join(outDir, `INDEX.txt`);
      fs.writeFileSync(files.checklistJson, JSON.stringify(cl, null, 1));
      fs.writeFileSync(files.checklist, checklistToText(cl, { contractOk: v.ok }));
      fs.writeFileSync(files.tokens, JSON.stringify(extractDesignTokens(bp, { includeAliases: true }), null, 1));
      fs.writeFileSync(files.assets, JSON.stringify({
        _comment: '资源导出表: vectors 由 MasterGo mcp_extractSvg 按 svgKey 回填 svg 字符串或落盘路径; images.src 为空时按 nodeId 从设计侧导出位图',
        vectors: cl.vectors,
        images: cl.images,
      }, null, 1));
      const kb = (n) => `${Math.round(n / 102.4) / 10}KB`;
      const indexLines = [
        `# UI 还原产物包 — ${base}`,
        `画布 ${bp.canvas.width}x${bp.canvas.height}${bp.canvas.scale ? `(原稿 ${bp.canvas.scale.factor}×已归一)` : ''}`,
        `门禁: ${v.ok ? '契约 PASS' : '契约 FAIL'} | ${bp.diffReport.verdict} | ${bp.styleDiffReport?.verdict || '-'} | ${bp.truthReport?.verdict || '-'}`,
        `输入体检: ${lint.ok ? 'PASS' : 'FAIL(见下方 WARN/FAIL 项, 先修复输入再消费)'}`,
        ...lint.checks.filter((c) => c.level === 'WARN' || c.level === 'FAIL').map((c) => `  ! [${c.level}] ${c.check}: ${c.detail}`),
        '',
        '消费顺序(渐进披露):',
        `1. 本文件 — 门禁基线与阅读地图`,
        `2. ${path.basename(files.checklist)} (${kb(fs.statSync(files.checklist).size)}) — 还原合同: 实现前必读/实现后自检`,
        `3. ${path.basename(files.outline)} (${kb(fs.statSync(files.outline).size)}) — 空间结构心智模型`,
        `4. ${path.basename(files.blueprint)} (${kb(fs.statSync(files.blueprint).size)}) — 精确数值, 按节点 id 查询`,
        `5. ${path.basename(files.tokens)} — DTCG token, 样式优先引用`,
        `6. ${path.basename(files.assets)} — 资源导出表(svgKey/nodeId → 实际资源)`,
        '',
        '实现完成后验证:',
        `  ui-restore verify ${path.basename(files.blueprint)}`,
        `  渲染侧: ui-restore diff <truth.png> <render.png> --blocks <mT>,<mR>; 失败时用 regions 定位差异区域`,
      ].join('\n');
      fs.writeFileSync(files.index, indexLines);
      for (const f of ['checklist', 'tokens', 'assets', 'index']) console.log(`${f}: ${files[f]} (${kb(fs.statSync(files[f]).size)})`);
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
    if (bpFlag) nodes = leafNodesOf(JSON.parse(fs.readFileSync(bpFlag, 'utf8')));
    const gridN = Number(flag('--grid')) || undefined;
    const topN = Number(flag('--top')) || undefined;
    const r = diffRegions(fs.readFileSync(truthPng), fs.readFileSync(renderPng), { nodes, grid: gridN, top: topN });
    console.log(JSON.stringify(r, null, 1));
    return;
  }
  console.error('用法: ui-restore <build|blueprint|doctor|verify|diff|regions> ...');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
