#!/usr/bin/env node
// ui-restore MCP Server — 通用 UI 还原能力的标准工具暴露面(适配器, 非核心)
//
// 任何 MCP 宿主(Claude/Cursor/自研 Agent)可直连; dsh 工具壳与本项目具同一核心。
// 只回答"设计稿 → 描述产物 → 验证", 代码生成在下游。
//
// 工具面(粗粒度原则, d2c 规划: MCP 是接口不是大脑):
//   ui_restore_run         主入口 workflow: analyze=设计稿→UI Truth 产物包 / verify=两图对比+修正指令
//   ui_restore_blueprint   设计稿 json → 蓝图 + outline + 契约/真值摘要
//   ui_restore_verify      蓝图 json → 契约校验 + 真值摘要
//   ui_restore_region      蓝图区域下钻(rect/ids → 子树), 大页面按需取精确数值
//   ui_restore_diff        真值/渲染两图(+文本块清单) → 像素/块级指标(+差异区域聚类+修正指令)
//   ui_restore_tokens      蓝图 json → DTCG 设计 token
//
// 传输: stdio。启动: node adapters/mcp-server.mjs
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  generateCodeBlueprint, initTextMetrics, validateBlueprint,
  blueprintToOutline, blueprintRegion, verifyLayoutTruth, comparePng, blockMetrics, decodePng,
  diffRegions, diffToCorrections,
  ingestDesignExport, extractDesignTokens,
} from '../dist/index.js';
import { analyzeDesign } from './pipeline.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });

const server = new McpServer({ name: 'ui-restore', version: '1.0.0' });

// 主入口 workflow tool(d2c: 普通情况下 Agent 只需要这一个)。确定性 pipeline, 非第二层 LLM。
server.tool(
  'ui_restore_run',
  'UI 还原主入口。mode=analyze(默认): 设计稿导出 json → UI Truth 产物包(blueprint/outline/checklist/tokens/assets) + 四闸门禁, 之后按产物包消费指南实现; mode=verify: 参考图 vs 渲染截图 → 差异区域 + LLM 可读修正指令(数值真值以蓝图为准, 用 ui_restore_region 下钻)。实现与修码由你(LLM)完成。',
  {
    design_path: z.string().optional().describe('设计稿导出 json 路径(mode=analyze 必填)'),
    out_dir: z.string().optional().describe('产物目录(mode=analyze)'),
    scale: z.string().optional().describe('画布倍率归一: 正数或 auto(mode=analyze)'),
    expect_sections: z.number().optional().describe('预期 section 数(MCP 枚举已知时传入防漏拉)(mode=analyze)'),
    truth_png: z.string().optional().describe('参考图路径(mode=verify 必填)'),
    render_png: z.string().optional().describe('渲染截图路径(mode=verify 必填)'),
    blueprint_path: z.string().optional().describe('蓝图 json 路径(mode=verify 必填)'),
  },
  async ({ design_path, out_dir, scale, expect_sections, truth_png, render_png, blueprint_path }) => {
    const mode = truth_png || render_png ? 'verify' : 'analyze';
    if (mode === 'verify') {
      if (!truth_png || !render_png || !blueprint_path) return text('mode=verify 需要 truth_png + render_png + blueprint_path');
      const bp = readJson(blueprint_path);
      const pT = fs.readFileSync(truth_png), pR = fs.readFileSync(render_png);
      const pixel = comparePng(pT, pR);
      const leaves = [];
      const walk = (n) => { if (!n || typeof n !== 'object') return; if (!Array.isArray(n.children) || !n.children.length) leaves.push(n); else n.children.forEach(walk); };
      for (const r of [...(bp.tree || []), ...(bp.floatings || [])]) walk(r);
      const regions = diffRegions(pT, pR, { nodes: leaves });
      const corrections = diffToCorrections(bp, regions);
      const lines = [
        `diffRatio: ${pixel.diffRatio} (差异像素 ${pixel.diffPixels})`,
        corrections ? `修正指令 — ${corrections.summary}` : '',
        ...(corrections ? corrections.corrections.map((c) => ' - ' + c) : []),
        '数值真值以 blueprint 为准; 用 ui_restore_region 下钻关联节点后修码, 修完重新截图再 verify。',
      ];
      return text(lines.filter(Boolean).join('\n'));
    }
    if (!design_path) return text('mode=analyze 需要 design_path');
    const r = await analyzeDesign(design_path, { outDir: out_dir, scale, expectSections: expect_sections });
    const g = r.summary.gates;
    const lines = [
      `门禁: 契约 ${g.contract} | 几何 ${g.geometry} | 样式 ${g.style} | 真值 ${g.truth}`,
      ...r.lint.checks.filter((c) => c.level !== 'INFO' && c.level !== 'PASS').map((c) => `! [${c.level}] ${c.check}: ${c.detail}`),
      '',
      blueprintToOutline(r.bp),
    ];
    return text(lines.join('\n'));
  }
);

server.tool(
  'ui_restore_blueprint',
  '设计稿导出 json(多 section, MasterGo/同类格式) → 技术中立代码蓝图。返回 blueprint.json 路径、outline 文本、契约与真值摘要。消费指南见 outline 尾部。',
  {
    design_path: z.string().describe('设计稿导出 json 路径: {meta:{canvas}, sections:[{x,y,dsl:{nodes,styles}}]}'),
    out_dir: z.string().optional().describe('产物目录(默认设计稿同目录)'),
    scale: z.string().optional().describe('画布倍率归一: 正数(如 2 = @2x 画板)或 auto(启发式检测); 缺省取导出 meta 声明, 否则原样'),
  },
  async ({ design_path, out_dir, scale }) => {
    await initTextMetrics();
    const raw = readJson(design_path);
    const declaredScale = raw?.meta?.scale ?? raw?.meta?.canvas?.scale;
    const { canvas, styles, nodes } = ingestDesignExport(raw);
    const bp = generateCodeBlueprint({ canvas, nodes, styles, scale: scale ?? declaredScale ?? null });
    const v = validateBlueprint(bp);
    const dir = out_dir || path.dirname(design_path);
    const base = path.basename(design_path).replace(/\.json$/, '');
    fs.mkdirSync(dir, { recursive: true });
    const bpPath = path.join(dir, `${base}.blueprint.json`);
    fs.writeFileSync(bpPath, JSON.stringify(bp));
    const outline = blueprintToOutline(bp);
    return text([
      `blueprint: ${bpPath}`,
      `契约: ${v.ok ? 'PASS' : 'FAIL ' + v.errors.slice(0, 3).join('; ')}`,
      `几何守恒: ${bp.diffReport?.verdict}`,
      `样式守恒: ${bp.styleDiffReport?.verdict || 'n/a'}`,
      ...(bp.canvas?.scale ? [`倍率: ${bp.canvas.scale.factor}×(${bp.canvas.scale.source}) → 已归一逻辑像素`] : []),
      `真值: ${bp.truthReport?.verdict}`,
      '', outline,
    ].join('\n'));
  }
);

server.tool(
  'ui_restore_region',
  '蓝图区域下钻: 大页面先读 outline 建空间心智, 对要实现/修正的区域取完整精确子树(rect 相交或 ids 命中), 避免整页蓝图全量进上下文',
  {
    blueprint_path: z.string(),
    rect: z.string().optional().describe('画布绝对矩形 "x,y,width,height"'),
    ids: z.string().optional().describe('节点 id 列表, 逗号分隔'),
  },
  async ({ blueprint_path, rect, ids }) => {
    const bp = readJson(blueprint_path);
    const sel = rect
      ? (() => { const [x, y, width, height] = rect.split(',').map(Number); return { x, y, width, height }; })()
      : { ids: (ids || '').split(',').map((s) => s.trim()).filter(Boolean) };
    const r = blueprintRegion(bp, sel);
    if (!r) return text('参数无效: 需要 rect 或 ids');
    return text(r);
  }
);

server.tool(
  'ui_restore_verify',
  '校验蓝图契约(BlueprintSchema v1)并做 Yoga 标准求解真值回验',
  { blueprint_path: z.string() },
  async ({ blueprint_path }) => {
    const bp = readJson(blueprint_path);
    const v = validateBlueprint(bp);
    const t = verifyLayoutTruth(bp);
    return text({
      contract: v.ok ? 'PASS' : v.errors,
      truth: t ? { verdict: t.verdict, maxDelta: t.maxDelta, matched: `${t.childrenMatched}/${t.childrenChecked}`, ratio: t.pixelPerfectRatio } : null,
    });
  }
);

server.tool(
  'ui_restore_diff',
  '真值/渲染两图对比: 像素层(pixelmatch) + 块级层(文本块清单可选) + 差异区域聚类与修正指令(蓝图可选)',
  {
    truth_png: z.string(),
    render_png: z.string(),
    blueprint_path: z.string().optional().describe('提供后附差异区域聚类 + LLM 可读修正指令(推荐)'),
    truth_blocks: z.string().optional().describe('真值文本块清单 json(启用块级指标)'),
    render_blocks: z.string().optional(),
    canvas: z.string().optional().describe('WxH, 默认取真值图尺寸'),
  },
  async ({ truth_png, render_png, blueprint_path, truth_blocks, render_blocks, canvas }) => {
    const pT = fs.readFileSync(truth_png), pR = fs.readFileSync(render_png);
    const pixel = comparePng(pT, pR);
    const out = { pixel: { diffPixels: pixel.diffPixels, diffRatio: pixel.diffRatio } };
    if (truth_blocks && render_blocks) {
      const [W, H] = canvas ? canvas.split('x').map(Number) : [pixel.width, pixel.height];
      const b = blockMetrics(readJson(truth_blocks), readJson(render_blocks), {
        designImg: decodePng(pT), renderImg: decodePng(pR), canvasWidth: W, canvasHeight: H,
      });
      out.blocks = { blockMatchRate: b.blockMatchRate, matchedPairs: b.matchedPairs, positionSimilarity: b.positionSimilarity, colorSimilarity: b.colorSimilarity, avgTextSimilarity: b.avgTextSimilarity };
      out.unmatchedRender = b.unmatchedRender.slice(0, 8);
    }
    if (blueprint_path) {
      const bp = readJson(blueprint_path);
      const leaves = [];
      const walk = (n) => { if (!n || typeof n !== 'object') return; if (!Array.isArray(n.children) || !n.children.length) leaves.push(n); else n.children.forEach(walk); };
      for (const r of [...(bp.tree || []), ...(bp.floatings || [])]) walk(r);
      const regions = diffRegions(pT, pR, { nodes: leaves });
      out.regions = regions;
      out.corrections = diffToCorrections(bp, regions);
    }
    return text(out);
  }
);

server.tool(
  'ui_restore_tokens',
  '蓝图 → DTCG 设计 token(颜色/字号/字重/圆角/阴影去重) + 节点别名表',
  { blueprint_path: z.string() },
  async ({ blueprint_path }) => {
    const bp = readJson(blueprint_path);
    // 别名表按需全量输出(蓝图内嵌的 designTokens 不含 aliases 防膨胀)
    const dt = extractDesignTokens(bp, { includeAliases: true });
    return text(dt);
  }
);

await server.connect(new StdioServerTransport());
