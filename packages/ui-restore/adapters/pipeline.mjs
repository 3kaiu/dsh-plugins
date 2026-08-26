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
  generateCodeBlueprint, initTextMetrics, validateBlueprint,
  blueprintToOutline, restorationChecklist, checklistToText,
  extractDesignTokens, ingestDesignExport, lintDesignExport,
  comparePng, blockMetrics, decodePng, diffRegions, diffToCorrections,
} from '../dist/index.js';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * 分析阶段: 设计稿导出 → UI Truth(蓝图) + 分层产物包。
 * @returns {{bp, contract, lint, files:Record<string,string>, summary}}
 */
export async function analyzeDesign(designPath, opts = {}) {
  await initTextMetrics();
  const raw = readJson(designPath);
  const declaredScale = raw?.meta?.scale ?? raw?.meta?.canvas?.scale;
  const lint = lintDesignExport(raw, { expectSections: opts.expectSections ? Number(opts.expectSections) : undefined });
  const { canvas, styles, nodes } = ingestDesignExport(raw);
  const bp = generateCodeBlueprint({ canvas, nodes, styles, scale: opts.scale ?? declaredScale ?? null });
  const contract = validateBlueprint(bp);

  const outDir = opts.outDir || path.dirname(designPath);
  const base = path.basename(designPath).replace(/\.json$/, '');
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, data) => { const p = path.join(outDir, name); fs.writeFileSync(p, data); return p; };
  const cl = restorationChecklist(bp);
  cl.gates.contract = contract.ok ? 'PASS' : 'FAIL';
  const outline = blueprintToOutline(bp);

  const files = {
    blueprint: write(`${base}.blueprint.json`, JSON.stringify(bp)),
    outline: write(`${base}.outline.txt`, outline),
    checklistJson: write(`${base}.checklist.json`, JSON.stringify(cl, null, 1)),
    checklist: write(`${base}.checklist.txt`, checklistToText(cl, { contractOk: contract.ok })),
    tokens: write(`${base}.tokens.json`, JSON.stringify(extractDesignTokens(bp, { includeAliases: true }), null, 1)),
    assets: write(`${base}.assets.json`, JSON.stringify({
      _comment: '资源导出表: vectors 由 MasterGo mcp_extractSvg 按 svgKey 回填 svg 字符串或落盘路径; images.src 为空时按 nodeId 从设计侧导出位图; id: 前缀为待导出矢量',
      vectors: cl.vectors,
      images: cl.images,
    }, null, 1)),
  };

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
      counts: cl.counts,
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
    const [W, H] = [pixel.width, pixel.height];
    const b = blockMetrics(readJson(opts.blocksTruth), readJson(opts.blocksRender), {
      designImg: decodePng(pT), renderImg: decodePng(pR), canvasWidth: W, canvasHeight: H,
    });
    out.blocks = { blockMatchRate: b.blockMatchRate, matchedPairs: b.matchedPairs, positionSimilarity: b.positionSimilarity, colorSimilarity: b.colorSimilarity, avgTextSimilarity: b.avgTextSimilarity };
    out.unmatchedRender = b.unmatchedRender.slice(0, 8);
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
