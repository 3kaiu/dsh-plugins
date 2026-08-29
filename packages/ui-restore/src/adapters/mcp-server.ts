#!/usr/bin/env node
// ui-restore MCP Server — 通用 UI 还原能力的标准工具暴露面(适配器, 非核心)
//
// 任何 MCP 宿主(Claude/Cursor/自研 Agent)可直连; dsh 工具壳与本项目具同一核心。
// 只回答"设计稿 → 描述产物 → 验证", 代码生成在下游。
//
// 工具面(粗粒度原则, d2c 规划: MCP 是接口不是大脑):
//   ui_restore_run         主入口 workflow: analyze=设计稿→UI Truth 产物包 / verify=两图对比+修正指令(+防退化记账)
//                                              restore=确定性状态机推进(绝不内置 LLM —— 实现/修码永远在调用方)
//   ui_restore_blueprint   设计稿 json → 蓝图 + outline + 契约/真值摘要
//   ui_restore_verify      蓝图 json → 契约校验 + 真值摘要
//   ui_restore_region      蓝图区域下钻(rect/ids → 子树), 大页面按需取精确数值
//   ui_restore_diff        真值/渲染两图(+文本块清单) → 像素/块级指标(+差异区域聚类+修正指令)
//   ui_restore_tokens      蓝图 json → DTCG 设计 token
//
// 传输: stdio。启动: node dist/mcp-server.js
import fs from 'node:fs';
import { makeGuard } from '../path-guard.ts';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  validateBlueprint, blueprintRegion, verifyLayoutTruth, blueprintToOutline, extractDesignTokens,
  evaluateGate, computeScore, comparePng, blockMetrics, decodePng, diffRegions, diffToCorrections,
} from '../index.ts';
// 编排逻辑单一来源(审计 P2 收敛): analyze/verify/diff 全部薄转发到 pipeline
import { analyzeDesign, buildBlueprint, verifyScreenshots, evaluateVerify, restoreAdvisor, MAX_ITERATIONS } from './pipeline.ts';
import { readJsonStrict } from '../fs-util.ts';
import { loadSession as loadSessionFile, saveSession as saveSessionFile } from '../session-store.ts';

// 路径越界防护（2026-08 接线）：守卫实现见 ./path-guard.mjs（可单测）。
// 所有工具参数路径（读/写）解析后必须落在收容根内，防 ../ 逃逸与任意文件读写。
const { confineUnder } = makeGuard();
import { confineTo } from '../path-guard.ts'; // makeGuard 不返回 confineTo —— 原解构得到 undefined, ui_restore_generate 会运行时崩溃(真 bug)
const readJson = (p) => readJsonStrict(confineUnder(p));
const readBuf = (p) => fs.readFileSync(confineUnder(p));
const optIn = (p) => (p ? confineUnder(p) : undefined);
const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });

// 维度钳制: 防止超大 canvas/width/height 触发大内存分配(DoS)
const clampDim = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(1, Math.min(100000, Math.floor(n))) : null; };

const server: any = new McpServer({ name: 'ui-restore', version: '1.0.0' }); // any: SDK 泛型重载对动态工具面(zod schema 对象)过严, 运行时以运行期校验为准

// 主入口 workflow tool(d2c: 普通情况下 Agent 只需要这一个)。确定性 pipeline, 非第二层 LLM。
server.tool(
  'ui_restore_run',
  'UI 还原主入口。mode=analyze(默认): 设计稿导出 json → UI Truth 产物包 + 四闸门禁; mode=verify: 参考图 vs 渲染截图 → 像素/块级指标 + 差异区域(含渲染侧文本块交叉引用 domHints) + LLM 可读修正指令; session_path 提供时附 iteration 记账与防退化(质量劣化自动要求回滚到最佳轮); mode=restore: 纯确定性状态机 —— 依会话返回当前 phase 与下一步动作(analyze→implement→correct→done/report), 绝不内置 LLM, 实现/修码由你完成。',
  {
    mode: z.enum(['analyze', 'verify', 'restore']).optional().describe('缺省按参数推断(有图=verify, 否则 analyze)'),
    design_path: z.string().optional().describe('设计稿导出 json 路径(mode=analyze 必填; restore 首次进会话时可用于自动补 analyze)'),
    out_dir: z.string().optional().describe('产物目录(mode=analyze)'),
    scale: z.string().optional().describe('画布倍率归一: 正数或 auto(mode=analyze)'),
    expect_sections: z.number().optional().describe('预期 section 数(MCP 枚举已知时传入防漏拉)(mode=analyze)'),
    session_path: z.string().optional().describe('会话 json(iteration 记账 + best 防退化 + restore 推进状态)。verify/restore 强烈建议提供'),
    truth_png: z.string().optional().describe('参考图路径(mode=verify 必填)'),
    render_png: z.string().optional().describe('渲染截图路径(mode=verify 必填)'),
    blueprint_path: z.string().optional().describe('蓝图 json 路径(mode=verify 必填)'),
    truth_blocks: z.string().optional().describe('真值文本块清单 json(可选, 与 render_blocks 成对启用块级 blockMatchRate)'),
    render_blocks: z.string().optional().describe('渲染文本块清单 json(可选, 与 truth_blocks 成对; 区域附带 domHints 渲染侧交叉引用)'),
  },
  async ({ mode, design_path, out_dir, scale, expect_sections, truth_png, render_png, blueprint_path, truth_blocks, render_blocks, session_path }) => {
    const sessionAbs = session_path ? confineUnder(session_path) : null;
    const loadSession = () => (sessionAbs ? loadSessionFile(sessionAbs) : null);
    const saveSession = (patch) => (sessionAbs ? saveSessionFile(sessionAbs, patch) : null);
    const m = mode || (truth_png || render_png ? 'verify' : 'analyze');

    // 第三态: restore 编排器 —— 只做确定性推进决策, 不实现任何 LLM 行为
    if (m === 'restore') {
      if (!session_path) return text('mode=restore 需要 session_path(单个 json 即全部会话状态)');
      let s = loadSession();
      if (!s?.phases?.analyze) {
        if (!design_path) return text('mode=restore: 会话尚无 analyze 记录 —— 提供 design_path 即自动执行 analyze 后进入 implement');
        const designAbs = optIn(design_path);
        const r = await analyzeDesign(designAbs, { outDir: optIn(out_dir), scale, expectSections: expect_sections });
        s = saveSession({ status: 'analyzed', source: { designPath: designAbs }, phases: { ...(s?.phases || {}), analyze: r.summary }, artifacts: r.files });
        const g = r.summary.gates;
        const lint = r.lint.checks.filter((c) => c.level !== 'INFO' && c.level !== 'PASS').map((c) => `! [${c.level}] ${c.check}: ${c.detail}`);
        const adv = restoreAdvisor(s);
        return text([`[analyze 完成] 门禁: 契约 ${g.contract} | 几何 ${g.geometry} | 样式 ${g.style} | 真值 ${g.truth}`, ...lint, '', `恢复点: phase=${adv.phase}`, '下一步:', ...adv.actions.map((a) => ' · ' + a)].join('\n'));
      }
      const adv = restoreAdvisor(s);
      const bestLine = s.best ? `best: iter#${s.best.iteration} key=${JSON.stringify(s.best.key)}${s.best.screenshot ? ` screenshot=${s.best.screenshot}` : ''}` : '';
      return text([`恢复点: phase=${adv.phase} (status=${s.status || 'none'}, iteration=${s.iteration || 0}/${MAX_ITERATIONS})`, ...(bestLine ? [bestLine] : []), '下一步:', ...adv.actions.map((a) => ' · ' + a)].join('\n'));
    }

    if (m === 'verify') {
      if (!truth_png || !render_png || !blueprint_path) return text('mode=verify 需要 truth_png + render_png + blueprint_path');
      // 统一走 pipeline.verifyScreenshots(审计收敛: 删除本地 walk/compare 拷贝;
      // 并补上块级层 —— 主入口此前反而拿不到 blockMatchRate, 而 AGENT 完成条件要求它=1)
      const r = verifyScreenshots({ truthPng: confineUnder(truth_png), renderPng: confineUnder(render_png), bpPath: confineUnder(blueprint_path), blocksTruth: optIn(truth_blocks), blocksRender: optIn(render_blocks) });
      const lines = [
        `diffRatio: ${r.pixel.diffRatio} (差异像素 ${r.pixel.diffPixels})`,
        r.blocks ? `块级层: ${JSON.stringify(r.blocks)}` : '',
        r.regions ? `差异区域: ${JSON.stringify(r.regions.regions?.slice(0, 5))}` : '',
        r.corrections ? `修正指令 — ${r.corrections.summary}` : '',
        ...(r.corrections ? r.corrections.corrections.map((c) => ' - ' + c) : []),
      ];
      if (session_path) {
        // 防退化与迭代记账(evaluateVerify 单一实现): 劣化轮次会被明确拒绝并要求回滚
        const d = evaluateVerify(r, loadSession() || {});
        saveSession({
          status: d.status, iteration: d.iteration, best: d.best, regressed: d.regressed, lastGuidance: d.guidance,
          verification: { screenshot: render_png, diffRatio: r.pixel.diffRatio, blockMatchRate: r.blocks?.blockMatchRate ?? null },
          phases: { ...(loadSession()?.phases || {}), [`verify-${d.iteration}`]: { pixel: r.pixel, blocks: r.blocks, corrections: r.corrections?.corrections } },
        });
        lines.push(`session: iteration=${d.iteration}/${MAX_ITERATIONS} status=${d.status}${d.regressed ? ' [REGRESSED]' : ''}`);
        for (const g of d.guidance) lines.push('· ' + g);
      } else {
        lines.push('数值真值以 blueprint 为准; 用 ui_restore_region 下钻关联节点后修码, 修完重新截图再 verify。');
      }
      return text(lines.filter(Boolean).join('\n'));
    }
    if (!design_path) return text('mode=analyze 需要 design_path');
    const designAbs = confineUnder(design_path);
    const r = await analyzeDesign(designAbs, { outDir: optIn(out_dir), scale, expectSections: expect_sections });
    if (session_path) {
      saveSession({ status: 'analyzed', source: { designPath: designAbs }, phases: { ...(loadSession()?.phases || {}), analyze: r.summary }, artifacts: r.files });
    }
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
    // 单一实现(审计收敛): 蓝图构建统一走 pipeline.buildBlueprint
    const designAbs = confineUnder(design_path);
    const { bp, v } = await buildBlueprint(designAbs, { scale: scale ?? undefined });
    const dir = optIn(out_dir) || path.dirname(designAbs);
    const base = path.basename(designAbs).replace(/\.json$/, '');
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
    const pT = readBuf(truth_png), pR = readBuf(render_png);
    const pixel = comparePng(pT, pR);
    const out: Record<string, any> = { pixel: { diffPixels: pixel.diffPixels, diffRatio: pixel.diffRatio } };
    if (truth_blocks && render_blocks) {
      const [W, H] = canvas ? canvas.split('x').map(Number) : [pixel.width, pixel.height];
      const cw = clampDim(W) ?? pixel.width, ch = clampDim(H) ?? pixel.height;
      const b = blockMetrics(readJson(truth_blocks), readJson(render_blocks), {
        designImg: decodePng(pT), renderImg: decodePng(pR), canvasWidth: cw, canvasHeight: ch,
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

server.tool(
  'ui_restore_profile',
  '项目 → Target Profile：扫描 package.json/pubspec/app.json/tsconfig，输出置信度排序的框架/样式决策（未知=unknown，绝不默认 css-modules）',
  {
    project_dir: z.string().describe('项目根目录'),
    out_path: z.string().optional().describe('落盘路径，缺省 <project>/restore.profile.json'),
    styling: z.string().optional().describe('显式覆盖样式方案'),
    framework: z.string().optional().describe('显式覆盖框架'),
  },
  async ({ project_dir, out_path, styling, framework }) => {
    const { analyzeProject, saveProfile } = await import('../index.ts');
    const projectAbs = confineUnder(project_dir);
    const r = analyzeProject(projectAbs, { overrides: { styling: styling || undefined, framework: framework || undefined } });
    const out = out_path ? confineUnder(out_path) : path.join(projectAbs, 'restore.profile.json');
    saveProfile(r.profile, out);
    return text({ profile: out, ...r.profile });
  }
);

server.tool(
  'ui_restore_generate',
  '蓝图+画像 → 代码：Strategy IR 热插拔多 serializer 生成组件 + preview.html + .restore-map.json（受 Generation Contract 约束，适配器可热插拔）',
  {
    blueprint_path: z.string(),
    project_dir: z.string().describe('目标项目根（落盘根）'),
    profile_path: z.string().optional().describe('restore.profile.json 路径，缺省自动以 unknown 兜底'),
    assets_path: z.string().optional().describe('回填后的 assets.json 路径'),
    out_subdir: z.string().optional().describe('相对 project_dir 的子目录，缺省 restore'),
    base_name: z.string().optional().describe('组件名，缺省 Restore'),
    serializer: z.enum(['react','vue','flutter','miniprogram','tailwind','html']).optional().describe('强制 serializer id，缺省按 profile 自动解析；热插拔新增 id 需同步扩展本枚举'),
  },
  async ({ blueprint_path, project_dir, profile_path, assets_path, out_subdir, base_name, serializer }) => {
    const { loadProfile, resolveProfile, planGeneration, resolveAssets, emitPreviewHtml, ensureBuiltins, resolveAdapterAsync } = await import('../index.ts');
    const bp = readJson(blueprint_path);
    const projectAbs = confineUnder(project_dir);
    const profile = profile_path ? (await import('../index.ts')).loadProfile(confineUnder(profile_path)) : (await import('../index.ts')).analyzeProject(projectAbs).profile;
    const plan = planGeneration(bp, profile);
    const assets = resolveAssets(bp, plan, { assetsExport: assets_path ? readJson(assets_path) : { vectors: [], images: [] }, assetDir: profile.assetDir, projectDir: projectAbs });
    // out_subdir 为 LLM 可控相对路径，同样收容（防 .. 逃逸出 project_dir）
    const outDir = confineTo(projectAbs, out_subdir || 'restore');
    await ensureBuiltins()
    const adapter = await resolveAdapterAsync(profile, serializer || undefined)
    const reactOut = adapter.emit(bp, plan, assets, profile, { baseName: base_name || 'Restore' })
    const ser = adapter.id
    const htmlOut = emitPreviewHtml(bp, plan, assets, profile, {});
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of [...reactOut.files, ...htmlOut.files]) {
      const p = confineTo(outDir, f.path); // 产物相对路径必须落在 outDir 内
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
    }
    const mapPath = path.join(outDir, '.restore-map.json');
    fs.writeFileSync(mapPath, JSON.stringify({ ...reactOut.map, preview: htmlOut.map }, null, 1));
    return text({ outDir, component: reactOut.componentName, serializer: ser, contract: plan.items.length, assets: assets.summary, map: mapPath, warnings: plan.warnings.slice(0, 3) });
  }
);

server.tool(
  'ui_restore_gate',
  '组合验收：global diff + critical regions + geometry(契约/样式)三闸合一，任一 FAIL 即整体 FAIL（truth 软门禁）。缺 blueprint 时结构证据缺失默认 FAIL（fail-closed）；确要纯像素闸须显式传 pixel_only=true',
  {
    truth_png: z.string(),
    render_png: z.string(),
    blueprint_path: z.string().optional(),
    assets_path: z.string().optional(),
    pixel_only: z.boolean().optional(),
  },
  async ({ truth_png, render_png, blueprint_path, assets_path, pixel_only }) => {
    const pT = readBuf(truth_png), pR = readBuf(render_png);
    const pixel = comparePng(pT, pR);
    let regions = null, blueprint = null, contract = null, assets = null;
    if (blueprint_path) {
      blueprint = readJson(blueprint_path);
      const leaves = [];
      const walk = (n) => { if (!n || typeof n !== 'object') return; if (!Array.isArray(n.children) || !n.children.length) leaves.push(n); else n.children.forEach(walk); };
      for (const r of [...(blueprint.tree || []), ...(blueprint.floatings || [])]) walk(r);
      regions = diffRegions(pT, pR, { nodes: leaves.map((n) => ({ id: n.id, name: n.name || '', text: typeof n.text === 'string' ? n.text : undefined, bounds: n.bounds })) });
      contract = validateBlueprint(blueprint);
    }
    if (assets_path && fs.existsSync(confineUnder(assets_path))) {
      const raw = readJson(assets_path);
      const list = raw.vectors || raw.assets || [];
      assets = { summary: { missing: list.filter((v) => !v.svg && !v.path && !v.src).length, total: list.length } };
    }
    const gate = evaluateGate({ pixel, regions, blueprint, contract, assets, allowMissingEvidence: pixel_only === true });
    const score = computeScore({ pixel, regions, blueprint, contract, assets });
    return text({ gate, score, pixel, regions: regions ? { clusterCount: regions.clusterCount, markedRatio: regions.markedRatio } : null });
  }
);

server.tool(
  'ui_restore_merge',
  'V2 合并：已生成文件（restore/）合入既有项目，冲突重命名，绝不覆盖业务代码',
  {
    project_dir: z.string(),
    from_dir: z.string().optional().describe('生成目录，缺省 <project>/restore'),
    on_conflict: z.enum(['rename','skip','overwrite']).optional(),
  },
  async ({ project_dir, from_dir, on_conflict }) => {
    const { mergeIntoProject, canMerge } = await import('../index.ts');
    const projectAbs = confineUnder(project_dir);
    const srcDir = from_dir ? confineUnder(from_dir) : path.join(projectAbs, 'restore');
    if (!fs.existsSync(srcDir)) return text(`生成目录不存在: ${srcDir}`);
    const check = canMerge(projectAbs);
    const files = [];
    const walk = (dir, base = '') => {
      for(const e of fs.readdirSync(dir, {withFileTypes:true})){
        const rel = path.join(base, e.name);
        const abs = path.join(dir, e.name);
        if(e.isDirectory()) walk(abs, rel);
        else files.push({ path: rel, content: fs.readFileSync(abs,'utf8') });
      }
    };
    walk(srcDir);
    const res = mergeIntoProject(projectAbs, files, { onConflict: on_conflict || 'rename' });
    return text({ ...res, check });
  }
);

await server.connect(new StdioServerTransport());
