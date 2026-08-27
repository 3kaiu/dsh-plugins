#!/usr/bin/env node
// truth-spike.mjs — P0-1 Truth Spike(v4 方案 §4: 最先做, 只验证获取链路, 不写功能)
//
// 问题: 「MasterGo container DSL link → 对应 viewport 完整 PNG」能否稳定获取?
// 三条候选链路按可靠性定级:
//   A design-export PNG   设计侧导出整页图 —— MasterGo MCP 工具面(mcp_getDsl/mcp_extractSvg/
//                         mcp_getDesignSections)无整页 PNG 导出能力, 仅能人工导出 → 自动化不可得
//   B golden screenshot   正确实现渲染截图(benchmarks/*/truth.png 同源可重截) —— 确定性链路
//   C geometry snapshot   renderGeometrySnapshot 蓝图确定性光栅化 —— 零外部依赖, 但无字体字形/
//                         渐变/阴影/位图(诚实边界见 visual-diff.ts)
// Spike 实测: 每案例 B vs C 的 diffRatio 与区域结构 → 定量给出 C 距 B 的保真差距,
// 依此裁决验收 truth 用哪层、C 只能承担什么角色。结论写 .dsh/truth-spike.json。
//
// 用法: node scripts/truth-spike.mjs [caseDir ...]   (缺省 = benchmarks/ 下全部含 design.json+truth.png 的案例)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBlueprint, collectLeaves } from '../packages/ui-restore/adapters/pipeline.mjs';
import { renderGeometrySnapshot, comparePng, diffRegions } from '../packages/ui-restore/dist/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function resolveCases(args) {
  if (args.length) return args;
  const bench = path.join(root, 'benchmarks');
  return fs.readdirSync(bench)
    .map((d) => path.join(bench, d))
    .filter((d) => fs.existsSync(path.join(d, 'design.json')) && fs.existsSync(path.join(d, 'truth.png')));
}

const cases = [];
for (const dir of resolveCases(process.argv.slice(2))) {
  const name = path.basename(dir);
  process.stdout.write(`case ${name}: `);
  const { bp } = await buildBlueprint(path.join(dir, 'design.json'));
  const truth = fs.readFileSync(path.join(dir, 'truth.png'));
  const geo = renderGeometrySnapshot(bp);
  const cmp = comparePng(truth, geo.png);
  const regions = diffRegions(truth, geo.png, { nodes: collectLeaves(bp) });
  cases.push({
    case: name,
    canvas: `${bp.canvas.width}x${bp.canvas.height}`,
    truthPng: `${cmp.width}x${cmp.height}`,
    tierCvsB: { diffRatio: cmp.diffRatio, diffPixels: cmp.diffPixels, regions: regions.clusterCount, markedRatio: regions.markedRatio },
  });
  console.log(`C vs B diffRatio=${cmp.diffRatio} 区域=${regions.clusterCount} 标记占比=${regions.markedRatio}`);
}

// 链路可用性定级(§4 出口: 明确 truth 来源与可靠性等级)
const report = {
  at: new Date().toISOString(),
  tiers: {
    A: { name: 'design-export-png', automated: false, note: 'MCP 无整页 PNG 导出工具面; 仅人工导出可用。V1 不作为自动化 truth 来源', role: '备用主 truth(人工供图时可替换 B)' },
    B: { name: 'golden-screenshot', automated: true, role: 'V1 默认主 truth', evidence: '确定性链路: W4 实测(2026-08-27)同源 restore.html 重截 diffPixels=0' },
    C: { name: 'geometry-snapshot', automated: true, role: '兜底: 仅几何/色块级健全性检查, 不得单独承担像素验收', empiricalGapVsB: Object.fromEntries(cases.map((c) => [c.case, c.tierCvsB.diffRatio])) },
  },
  policy: {
    truthPriority: ['A(人工供图, 可选)', 'B(golden 截图, 默认)', 'C(几何快照, 兜底/快检)'],
    acceptance: '验收像素层一律以 A/B 为参照; C 仅用于生成前几何健全性检查与无 B 时的降级标记(验收降级为几何闸+区域结构)',
  },
  cases,
};
const outPath = path.join(root, '.dsh', 'truth-spike.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(`\n结论: A(自动)不可得 | B=V1 主 truth(已证确定性) | C 保真差距 diffRatio=${cases.map((c) => c.tierCvsB.diffRatio).join('/')} → 仅兜底`);
console.log(`报告: ${outPath}`);
