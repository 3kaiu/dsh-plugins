#!/usr/bin/env node
// pipeline.mjs — UI Restore 确定性流水线(d2c 规划 Phase1 Source/Understand + Phase5 Compare)
//
// 定位: Workflow Tool 的执行内核 —— 纯确定性编排, 无 LLM; 实现/修码永远在调用方(LLM)侧。
// 三方复用: cli.mjs(命令行) / mcp-server.mjs(工具面) / restore.mjs(workflow runner)。
//
//   analyzeDesign()    设计稿 json → 蓝图+产物包+四闸摘要        (Phase 1/2: Source → UI Truth)
//   verifyScreenshots() truth/render 两图 → 像素/块级指标 + 区域聚类 + 修正指令 (Phase 5: Compare)
import fs from 'node:fs';
import path from 'node:path';
import {
  initTextMetrics, validateBlueprint,
  blueprintToOutline, restorationChecklist, checklistToText,
  extractDesignTokens, ingestDesignExport, lintDesignExport,
  generateCodeBlueprint,
  comparePng, blockMetrics, decodePng, diffRegions, diffToCorrections,
} from '../dist/index.js';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** 蓝图管线公共段(scale 优先级: 显式参数 > 导出 meta 声明 > 不归一)。唯一实现 —— cli/mcp 一律薄转发到本模块(审计 P2 收敛: 原三处拷贝已出现行为分叉) */
export async function buildBlueprint(designPath, opts = {}) {
  await initTextMetrics();
  const raw = readJson(designPath);
  const declaredScale = raw?.meta?.scale ?? raw?.meta?.canvas?.scale;
  const expect = opts.expectSections;
  const lint = lintDesignExport(raw, { expectSections: expect != null && expect !== '' ? Number(expect) : undefined });
  const { canvas, styles, nodes } = ingestDesignExport(raw);
  const bp = generateCodeBlueprint({ canvas, nodes, styles, scale: opts.scale ?? declaredScale ?? null });
  return { bp, v: validateBlueprint(bp), raw, lint };
}

/** 蓝图全部叶子节点(diffRegions 的候选映射输入)。此前 cli/mcp/pipeline 共四份相同 walk 拷贝, 已收敛于此 */
export function collectLeaves(bp) {
  const leaves = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (!Array.isArray(n.children) || n.children.length === 0) leaves.push(n);
    else for (const c of n.children) walk(c);
  };
  for (const r of [...(bp.tree || []), ...(bp.floatings || [])]) walk(r);
  return leaves.map((n) => ({ id: n.id, name: n.name || '', text: typeof n.text === 'string' ? n.text : undefined, bounds: n.bounds }));
}

/**
 * 共享产物包写盘: 分层产物 + INDEX.txt 阅读地图。
 * (审计修复: 原 analyzeDesign 不产 INDEX.txt, workflow/MCP 主入口与 SKILL §③ 承诺不符)
 */
export function writeArtifactBundle(bp, v, lint, outDir, base) {
  fs.mkdirSync(outDir, { recursive: true });
  const cl = restorationChecklist(bp);
  cl.gates.contract = v.ok ? 'PASS' : 'FAIL';  const files = {};
  const write = (name, data) => { const p = path.join(outDir, name); fs.writeFileSync(p, data); return p; };
  files.blueprint = write(`${base}.blueprint.json`, JSON.stringify(bp));
  files.outline = write(`${base}.outline.txt`, blueprintToOutline(bp));
  files.checklistJson = write(`${base}.checklist.json`, JSON.stringify(cl, null, 1));
  files.checklist = write(`${base}.checklist.txt`, checklistToText(cl, { contractOk: v.ok }));
  files.tokens = write(`${base}.tokens.json`, JSON.stringify(extractDesignTokens(bp, { includeAliases: true }), null, 1));
  files.assets = write(`${base}.assets.json`, JSON.stringify({
    _comment: '资源导出表: vectors 由 MasterGo mcp_extractSvg 按 svgKey 回填 svg 字符串或落盘路径; images.src 为空时按 nodeId 从设计侧导出位图; id: 前缀为待导出矢量',
    vectors: cl.vectors,
    images: cl.images,
  }, null, 1));
  const kb = (n) => `${Math.round(n / 102.4) / 10}KB`;
  files.index = write('INDEX.txt', [
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
    `  node adapters/restore.mjs verify <truth.png> <render.png> --bp ${path.basename(files.blueprint)} --session s.json`,
    `  渲染侧: ui-restore diff <truth.png> <render.png>; 失败时用 ui-restore regions 定位差异区域`,
  ].join('\n'));
  // counts 一并返回: workflow 主入口的 summary.counts 与 checklist 同源, 不再二次遍历
  return { files, counts: cl.counts };
}

/**
 * 分析阶段: 设计稿导出 → UI Truth(蓝图) + 分层产物包(含 INDEX.txt)。
 * @returns {{bp, contract, lint, files:Record<string,string>, summary}}
 */
export async function analyzeDesign(designPath, opts = {}) {
  const { bp, v: contract, lint } = await buildBlueprint(designPath, opts);
  const outDir = opts.outDir || path.dirname(designPath);
  const base = path.basename(designPath).replace(/\.json$/, '');
  const { files, counts } = writeArtifactBundle(bp, contract, lint, outDir, base);

  return {
    bp,
    contract,
    lint,
    files,
    summary: {
      base,
      outDir,
      canvas: bp.canvas,
      gates: {
        contract: contract.ok ? 'PASS' : 'FAIL',
        geometry: bp.diffReport?.verdict ?? null,
        style: bp.styleDiffReport?.verdict ?? null,
        truth: bp.truthReport?.verdict ?? null,
      },
      counts,
      lintOk: lint.ok,
    },
  };
}

/**
 * 对比阶段: 参考图 vs 渲染截图 → 指标 + 差异区域聚类 + LLM 可读修正指令。
 * @param {object} opts {truthPng, renderPng, bpPath?, blocksTruth?, blocksRender?, grid?, top?}
 * @returns {{pixel, blocks?, regions?, corrections?}}
 */
export function verifyScreenshots(opts) {
  const { truthPng, renderPng } = opts;
  const pT = fs.readFileSync(truthPng);
  const pR = fs.readFileSync(renderPng);
  const pixel = comparePng(pT, pR);
  const out = { pixel: { diffPixels: pixel.diffPixels, diffRatio: pixel.diffRatio } };

  if (opts.blocksTruth && opts.blocksRender) {
    // canvas 显式覆盖(ui_restore_diff 的 WxH 语义), 缺省取真值图尺寸
    const [W, H] = opts.canvas ?? [pixel.width, pixel.height];
    const b = blockMetrics(readJson(opts.blocksTruth), readJson(opts.blocksRender), {
      designImg: decodePng(pT), renderImg: decodePng(pR), canvasWidth: W, canvasHeight: H,
    });
    out.blocks = { blockMatchRate: b.blockMatchRate, matchedPairs: b.matchedPairs, positionSimilarity: b.positionSimilarity, colorSimilarity: b.colorSimilarity, avgTextSimilarity: b.avgTextSimilarity };
    out.unmatchedRender = b.unmatchedRender.slice(0, 8);
    // 设计侧未命中同样需要暴露(runner 诊断双侧粒度差): 此前只出 render 侧导致好例 BMR 偏低时无法归因
    out.unmatchedDesign = b.unmatchedDesign.slice(0, 8);
  }

  if (opts.bpPath) {
    const bp = readJson(opts.bpPath);
    const leaves = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (!Array.isArray(n.children) || n.children.length === 0) leaves.push(n);
      else for (const c of n.children) walk(c);
    };
    for (const r of [...(bp.tree || []), ...(bp.floatings || [])]) walk(r);
    const regions = diffRegions(pT, pR, { nodes: leaves, grid: opts.grid, top: opts.top });
    out.regions = regions;
    out.corrections = diffToCorrections(bp, regions);
  }
  return out;
}
