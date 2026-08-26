#!/usr/bin/env node
// ui-restore MCP Server — 通用 UI 还原能力的标准工具暴露面(适配器, 非核心)
//
// 任何 MCP 宿主(Claude/Cursor/自研 Agent)可直连; dsh 工具壳与本项目具同一核心。
// 只回答"设计稿 → 描述产物 → 验证", 代码生成在下游。
//
// 工具面:
//   ui_restore_blueprint   设计稿 json → 蓝图 + outline + 契约/真值摘要
//   ui_restore_verify      蓝图 json → 契约校验 + 真值摘要
//   ui_restore_diff        真值/渲染两图(+文本块清单) → 像素/块级指标
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
  blueprintToOutline, verifyLayoutTruth, comparePng, blockMetrics, decodePng,
  ingestDesignExport, extractDesignTokens,
} from '../dist/index.js';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });

const server = new McpServer({ name: 'ui-restore', version: '1.0.0' });

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
  '真值/渲染两图的像素层(pixelmatch)与块级层(Design2Code 风格指标)对比',
  {
    truth_png: z.string(),
    render_png: z.string(),
    truth_blocks: z.string().optional().describe('真值文本块清单 json(启用块级指标)'),
    render_blocks: z.string().optional(),
    canvas: z.string().optional().describe('WxH, 默认取真值图尺寸'),
  },
  async ({ truth_png, render_png, truth_blocks, render_blocks, canvas }) => {
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
