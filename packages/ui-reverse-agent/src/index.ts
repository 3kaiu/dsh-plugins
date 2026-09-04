// dsh-ui-reverse-agent: Visual Reverse Engineering Agent 工具集
// 复用 layout-infer 的 4+2 个工具，新增感知/对比/守卫/记忆层工具（§3.1）

// Type workaround for JsonValue compatibility
type AnyJson = any;

import { defineTool } from "@deepseek-ai/dsh-tools";
import { compareGeometry, compareTypography, comparePalette, compareScreenshots, scoreReport, antiHackScan } from "@3kaiu/dsh-plugin-kit";
import { referenceIngest } from "./perception/reference.ts";
import * as browser from "./perception/browser.ts";
import { DevServer } from "./services/devserver.ts";
import { stateRead, stateUpdate, syncGoalsAndTodo, initStorageBackend, storageBackendName } from "./memory/state.ts";
import { PROMPT_TEMPLATE } from "./agent/prompt.ts";
import { COMPLETE_THRESHOLD, applyConfig, runtimeConfig, Config } from "./config.ts";
import { fanoutEvaluate, generateCandidates } from "./guard/fanout.ts";
import { neutralIngest, neutralToBlueprint } from "./perception/neutral-ingest.ts";
import { verifyNeutral } from "./guard/verify-neutral.ts";
import { expandMatrix, aggregateMatrixScores, checkResponsive } from "./perception/viewport-matrix.ts";
import { mapTypographyTokens, mapPaletteTokens } from "./services/token-map.ts";
import { checkDesignConstraints, filterByConstraints } from "./guard/design-constraints.ts";
import { hashOf, cacheKey, getCached, setCached } from "./services/cache.ts";
import { checkA11y } from "./guard/a11y.ts";
import { filterAbandonedSections, paginateSections, largeFileDiagnostics } from "./services/large-file.ts";
import { classifyError, recoveryPlan, withRetry } from "./guard/recovery.ts";
import { buildCiReport, writeCiArtifacts, ciGate } from "./services/ci.ts";
import { checkDslSecurity, sanitizeDsl, sanitizeText, isAllowedUrl } from "./guard/security.ts";
import { gitStatus, ensureRollbackPoint } from "./services/git.ts";
import { isCjk, cjkFontFallback, cjkLineBreak, cjkPunctWidth } from "./services/cjk.ts";
import { extractAnimations, compareAnimations } from "./services/animation.ts";

const name = "dsh-ui-reverse-agent";
const renderJson = (_args: any, value: any) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];
const inject = {
  required: ["tools"],
  optional: ["systemPrompt", "planMode", "storageDomain", "goals", "todo"]
};


let devServerInstance: any = null;

function apply(ctx: any, config: any) {
  applyConfig(config); // yml config 经 schemastery 校验后写入 runtimeConfig(此前被静默丢弃)
  // ── Preset Persona（若宿主提供 systemPrompt 则覆盖 deployment persona） ──
  try {
    if (ctx.systemPrompt?.section) {
      ctx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: PROMPT_TEMPLATE, complete: true });
    }
  } catch {}
  try {
    if (ctx.systemPrompt?.variable) {
      // 契约: variable(name, provider) —— 传对象会 throw(被下面 catch 吞掉),
      // 导致 persona 里的 {{COMPLETE_THRESHOLD}} 从未被替换(2026-08 修复)。
      ctx.systemPrompt.variable("COMPLETE_THRESHOLD", () => String(runtimeConfig.completeThreshold));
    }
  } catch {}
  // ── 每轮状态快照（官方 systemPrompt.context seam）──
  // 把 .ui-reverse/state.json 的关键运行状态注册为 user-role 快照消息，
  // 替代模型每轮手动调 state_read（快照内容是数据，非指令——见 persona 隔离章节）。
  try {
    if (ctx.systemPrompt?.context) {
      ctx.systemPrompt.context({
        name: 'ui-reverse:state-snapshot',
        order: 150,
        text: () => {
          try {
            const r = stateRead({})
            if (!r?.exists) return ''
            const s = r.state || {}
            const cur = s.scores?.current
            if (cur == null || (cur.total == null && s.iteration == null)) return ''
            const top = (s.remainingDifferences || [])
              .slice(0, 5)
              .map((d: any) => `[P${d.priority ?? '?'}] ${d.path || d.description || d.area || ''}`.trim())
              .filter((t: any) => t.length > 4)
              .join('; ')
            return [
              '[ui-reverse 运行状态快照 — 仅作数据参考]',
              `iteration: ${s.iteration ?? 0}`,
              `score: ${cur.total ?? 'n/a'} (Δ ${s.scores?.delta ?? 'n/a'})`,
              top ? `top differences: ${top}` : 'top differences: (无记录)',
            ].join('\n')
          } catch {
            return ''
          }
        },
      });
    }
  } catch {}
  // ── Storage 后端探测：宿主挂载 storageDomain 时 state 走 domain（原子/持久/事件），否则 fs 回退 ──
  try { void initStorageBackend(ctx) } catch {}
  // Plan Mode 隔离：宿主若提供 planMode 服务，ui-reverse 的 phase0-4 默认在 plan scope 执行
  // 由 preset 的 agent.cordis.yml isolate 配置保证，此处仅做兼容探测
  try { if (ctx.planMode) { /* planMode 服务存在即支持 scope 隔离 */ } } catch {}

  // ── Perception: reference_ingest ──────────────────────────────────
  ctx.tools.register(defineTool({
    name: "reference_ingest",
    timeoutMs: 120000,
    description: "摄取参考输入（截图/DSL/URL）并构建 Visual Blueprint：布局树 + 排版档案 + 调色板 + 资产清单 + 状态/视口清单，落盘 .ui-reverse/blueprint.json，供后续对比使用。输入 dsl 为 MasterGo DSL 或拍平稿 sections，screenshotPaths 为截图路径数组，url 为参考 URL（走 browser_dom_dump 管线）。",
    parameters: {
      dsl: { type: "json", description: "MasterGo DSL 或拍平稿 sections 数组" },
      screenshotPaths: { type: "json", description: "参考截图路径数组" },
      url: { type: "string", description: "参考 URL（与 dsl/screenshotPaths 三选一）" },
      viewport: { type: "json", description: "视口 {width,height}，默认 1440x900" },
      outPath: { type: "string", description: "blueprint 输出路径，默认 .ui-reverse/blueprint.json" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args, exec) => referenceIngest(args, { browserDomDump: browser.browserDomDump, signal: exec?.signal }) as any,
  }));

  // ── Perception: browser_* ────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "browser_start",
    timeoutMs: 90000,
    description: "启动 dev server（如未起）+ chromium，返回 URL 与健康状态。输入 devCommand/cwd/port 可托管子进程；url 为目标页。",
    parameters: {
      url: { type: "string", description: "目标 URL，默认 http://localhost:3000" },
      devCommand: { type: "string", description: "dev server 启动命令，如 pnpm dev" },
      cwd: { type: "string", description: "项目根路径" },
      port: { type: "number", description: "端口" },
      headless: { type: "boolean", description: "是否 headless，默认 true" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args, exec) => {
      if (args.devCommand || args.port) {
        devServerInstance = new DevServer({ command: args.devCommand, cwd: args.cwd, port: args.port });
        try { await devServerInstance.start({ signal: exec?.signal }) } catch (e) { if (exec?.signal?.aborted) throw e }
      }
      const url = args.url || devServerInstance?.url || "http://localhost:3000";
      return browser.browserStart({ url, headless: args.headless !== false, signal: exec?.signal }) as any;
    },
  }));

  ctx.tools.register(defineTool({
    name: "browser_viewport",
    description: "设置视口与 deviceScaleFactor",
    parameters: {
      width: { type: "number", required: true, description: "视口宽度" },
      height: { type: "number", required: true, description: "视口高度" },
      dpr: { type: "number", description: "deviceScaleFactor，默认 2" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args, exec) => browser.browserViewport({ ...args, signal: exec?.signal }) as any,
  }));

  ctx.tools.register(defineTool({
    name: "browser_navigate",
    timeoutMs: 30000,
    description: "导航到目标页",
    parameters: { url: { type: "string", required: true, description: "目标 URL" } },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args, exec) => browser.browserNavigate({ url: args.url, signal: exec?.signal }) as any,
  }));

  ctx.tools.register(defineTool({
    name: "browser_screenshot",
    timeoutMs: 30000,
    description: "截图（full-page / viewport / element）→ PNG 文件",
    parameters: {
      path: { type: "string", description: "输出路径，默认 .ui-reverse/artifacts/current-*.png" },
      fullPage: { type: "boolean", description: "是否全页，默认 true" },
      selector: { type: "string", description: "元素选择器，仅截该元素" },
    },
    output: {
      schema: { type: "json" },
      render: renderJson,
      presentationMeta: (_args, value: any) => (value && value.path ? { path: value.path, fullPage: value.fullPage } : undefined) as any,
    },
    presentCall: (args: any) => ({
      card: "generic",
      kind: "other",
      title: args.selector ? `截图元素 ${args.selector}` : args.fullPage === false ? "视口截图" : "全页截图",
      ...(args.path ? { locations: [{ path: args.path }] } : {}),
    }),
    presentResult: (_args, result: any) => (result && !result.isError && result.meta?.path ? { card: "generic", title: `截图完成 → ${result.meta.path}` } : undefined),
    execute: async (args, exec) => browser.browserScreenshot({ path: args.path, fullPage: args.fullPage, selector: args.selector, signal: exec?.signal }) as any,
  }));

  ctx.tools.register(defineTool({
    name: "browser_dom_dump",
    timeoutMs: 30000,
    description: "结构化 DOM dump：可见元素树 + rect + computed styles 子集（display/flexDirection/gap/padding/font*/color 等），供 page_layout_tree 使用",
    parameters: {
      selector: { type: "string", description: "根选择器，默认 body" },
      includeComputed: { type: "boolean", description: "是否包含 computed，默认 true" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    presentCall: (args: any) => ({ card: "generic", kind: "read", title: `DOM dump ${args.selector || "body"}` }),
    execute: async (args, exec) => browser.browserDomDump({ selector: args.selector, includeComputed: args.includeComputed !== false, signal: exec?.signal }) as any,
  }));

  ctx.tools.register(defineTool({
    name: "browser_state_trigger",
    timeoutMs: 30000,
    description: "CDP 强制伪状态（hover/active/focus/disabled/checked）并截图",
    parameters: {
      state: { type: "string", required: true, description: "hover | active | focus | disabled | checked" },
      selector: { type: "string", description: "目标选择器" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args, exec) => browser.browserStateTrigger({ ...args, signal: exec?.signal }) as any,
  }));

  ctx.tools.register(defineTool({
    name: "browser_console",
    description: "console 错误、未加载资源、字体加载状态检查",
    parameters: {},
    output: { schema: { type: "json" }, render: renderJson },
    execute: async () => browser.browserConsole() as any,
  }));

  ctx.tools.register(defineTool({
    name: "browser_stop",
    description: "关闭当前 context/page，保留 browser 复用；进程结束时用 browserClose",
    parameters: {},
    output: { schema: { type: "json" }, render: renderJson },
    execute: async () => browser.browserStop(),
  }));

  // ── Measure: compare_geometry ────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "compare_geometry",
    description: "几何偏差：蓝图 regions / 参考树 vs 实现树 → 每节点 x/y/w/h 偏差（px），高于容差（默认 2px）即记 mismatch",
    parameters: {
      referenceTree: { type: "json", required: true, description: "参考树（blueprint.json 的 tree）" },
      implementedTree: { type: "json", required: true, description: "实现树（page_layout_tree 的 tree）" },
      tolerance: { type: "number", description: "容差 px，默认 2" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => compareGeometry({ referenceTree: args.referenceTree, implementedTree: args.implementedTree, tolerance: args.tolerance }) as any,
  }));

  ctx.tools.register(defineTool({
    name: "compare_typography",
    description: "排版偏差：实现侧文字度量 vs 排版档案 → 逐文本节点 family/size/weight/lineHeight/letterSpacing/color 偏差",
    parameters: {
      referenceTree: { type: "json", required: true, description: "参考树" },
      implementedTree: { type: "json", required: true, description: "实现树" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => compareTypography({ referenceTree: args.referenceTree, implementedTree: args.implementedTree, implementedMetrics: undefined, referenceProfile: undefined } as any) as any,
  }));

  ctx.tools.register(defineTool({
    name: "compare_palette",
    description: "色彩偏差：实现侧主色 vs 参考调色板 → CIEDE2000 ΔE 列表，阈值 3",
    parameters: {
      referencePalette: { type: "json", description: "参考调色板 hex 数组" },
      implementedPalette: { type: "json", description: "实现侧调色板 hex 数组" },
      referenceTree: { type: "json", description: "参考树（自动提取调色板）" },
      implementedTree: { type: "json", description: "实现树（自动提取调色板）" },
      deltaEThreshold: { type: "number", description: "ΔE 阈值，默认 3" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => comparePalette({ referencePalette: args.referencePalette, implementedPalette: args.implementedPalette, referenceTree: args.referenceTree, implementedTree: args.implementedTree, deltaEThreshold: args.deltaEThreshold }) as any,
  }));

  // ── Compare: pixel + score ──────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "compare_screenshots",
    timeoutMs: 60000,
    description: "像素对比：对齐 + SSIM + 像素差 + 热图 PNG + 分层分数。mode strict 要求同视口同比例，auto 先对齐",
    parameters: {
      reference: { type: "string", required: true, description: "参考截图路径" },
      current: { type: "string", required: true, description: "当前截图路径" },
      mode: { type: "string", description: "strict | auto，默认 strict" },
    },
    output: {
      schema: { type: "json" },
      render: renderJson,
      // 官方卡片契约：meta 投影持久化进 session log，presentResult 从 result.meta 读回
      presentationMeta: (_args, value: any) => (value && !value.error ? { ssim: value.ssim, pixelDiffRatio: value.pixelDiffRatio, heatmap: value.heatmap, aligned: value.aligned } : undefined) as any,
    },
    presentCall: (args: any) => ({ card: "generic", kind: "other", title: `截图对比(${args.mode || "strict"})`, rawInput: { reference: args.reference, current: args.current } }),
    presentResult: (_args, result: any) => {
      if (!result || result.isError) return undefined;
      const m = result.meta || {};
      if (m.ssim == null) return undefined;
      return { card: "generic", title: `相似度 ${Number(m.ssim).toFixed(3)} ｜ 像素差 ${(Number(m.pixelDiffRatio ?? 0) * 100).toFixed(1)}%${m.heatmap ? ` ｜ 热图 ${m.heatmap}` : ""}` };
    },
    execute: async (args: any) => compareScreenshots({ reference: args.reference, current: args.current, mode: args.mode }) as any,
  }));

  ctx.tools.register(defineTool({
    name: "score_report",
    description: "加权评分：S=0.30*S_struct+0.30*S_geom+0.20*S_pixel+0.10*S_type+0.10*S_color，输出总分 + 分层分 + ΔS + regression 标记",
    parameters: {
      struct: { type: "number", description: "结构层分数 0..1" },
      geom: { type: "number", description: "几何层分数 0..1" },
      pixel: { type: "number", description: "像素层分数 0..1 (SSIM)" },
      type: { type: "number", description: "排版层分数 0..1" },
      color: { type: "number", description: "色彩层分数 0..1" },
      previousTotal: { type: "number", description: "上一轮总分，用于 ΔS" },
      blocked: { type: "boolean", description: "是否被 anti_hack_scan 阻断" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => scoreReport({ struct: args.struct, geom: args.geom, pixel: args.pixel, type: args.type, color: args.color, previousTotal: args.previousTotal, blocked: args.blocked }) as any,
  }));

  // ── Guard: fanout_evaluate（Phase5 扇出，纯测量，可并行） ──────────
  ctx.tools.register(defineTool({
    name: "fanout_evaluate",
    timeoutMs: 120000,
    description: "扇出评估：对同一差异的多个候选修复值（gap/padding/size 等）打补丁→重对比→预测 ΔS，返回按总分降序的 ranked 列表。纯测量不改文件，可安全并行（isConcurrencySafe），供 Phase5 单假设择优，避免盲改。",
    parameters: {
      mismatch: { type: "json", required: true, description: "单个 mismatch 对象，来自 compare_geometry/compare_layouts（含 path/prop/expected/actual）" },
      candidates: { type: "json", description: "候选修复值数组，如 [24,16,20] 或 [{value:24,label:'gap 24'}]，为空则自动生成 期望/±1px 三候选" },
      referenceTree: { type: "json", required: true, description: "参考树（blueprint.json 的 tree）" },
      implementedTree: { type: "json", required: true, description: "实现树（page_layout_tree 输出）" },
      tolerance: { type: "number", description: "容差 px，默认 2" },
      currentScore: { type: "number", description: "当前总分，用于 Δ 预测" },
      currentLayers: { type: "json", description: "当前各层得分 {struct,geom,pixel,type,color}（来自 score_report.layers）—— 提供后不可观测层沿用真实分, 缺省 0.9 占位" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    isConcurrencySafe: () => true,
    execute: async (args: any): Promise<any> => fanoutEvaluate({
      mismatch: args.mismatch,
      candidates: args.candidates,
      referenceTree: args.referenceTree,
      implementedTree: args.implementedTree,
      tolerance: args.tolerance,
      currentScore: args.currentScore,
      currentLayers: args.currentLayers,
    }),
  }));

  // ── Guard: anti_hack_scan ───────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "anti_hack_scan",
    description: "静态反 hack 扫描：absolute 占比 / canvas 覆盖 / 背景冒充 / 隐藏 DOM / 图片代文字等，blocker 违规直接阻断计分",
    parameters: {
      domDump: { type: "json", description: "最新 browser_dom_dump 输出" },
      treeStats: { type: "json", description: "page_layout_tree 的 stats" },
      reference: { type: "json", description: "blueprint 摘要（含 stats.absolute）" },
      codeStats: { type: "json", description: "可选的仓库静态扫描结果（inlineStyleCount 等）" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => antiHackScan({ domDump: args.domDump, treeStats: args.treeStats, reference: args.reference, codeStats: args.codeStats }) as any,
  }));

  // ── Memory: state_read / state_update ───────────────────────────
  ctx.tools.register(defineTool({
    name: "state_read",
    description: "读取 UI Reconstruction State（.ui-reverse/state.json）",
    parameters: { statePath: { type: "string", description: "state.json 路径，默认 .ui-reverse/state.json" } },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => stateRead({ statePath: args.statePath }) as any,
  }));

  ctx.tools.register(defineTool({
    name: "state_update",
    description: "更新 UI Reconstruction State（append-only，同步写 history/ + goals/todo 双写），每轮结束必须调用",
    parameters: {
      patch: { type: "json", required: true, description: "要合并到 state 的 patch 对象" },
      statePath: { type: "string", description: "state.json 路径" },
      historyNote: { type: "string", description: "本轮备注，写入 history/" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args) => {
      const res = await stateUpdate(args.patch as any, { statePath: args.statePath, historyNote: args.historyNote });
      // Goals/TODO 双写：文件已由 stateUpdate 内 syncGoalsAndTodo 完成；此处再尝试 ctx 级别同步（若宿主挂载）
      try {
        if (ctx.goals || ctx.todo) {
          syncGoalsAndTodo(res.state as any, { statePath: res.path } as any);
        }
      } catch {}
      return res as any;
    },
  }));

  // ── Perception: neutral_ingest（doc15 中立树 → blueprint） ──────────
  ctx.tools.register(defineTool({
    name: "neutral_ingest",
    description: "摄取中立树（doc15 tree.json，render-dsl 输出）并转为 Visual Blueprint。不重新推导，已含 lineHeight/文字色/stroke 等已验证细节，落盘 .ui-reverse/blueprint.json。",
    parameters: {
      neutralTree: { type: "json", description: "中立树对象（{meta,root}）" },
      neutralPath: { type: "string", description: "中立树文件路径（与 neutralTree 二选一）" },
      outPath: { type: "string", description: "blueprint 输出路径，默认 .ui-reverse/blueprint.json" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args) => neutralIngest(args) as any,
  }));

  // ── Guard: verify_neutral（doc14 §5 确定性验证 + Phase6 互补） ────
  ctx.tools.register(defineTool({
    name: "verify_neutral",
    timeoutMs: 60000,
    description: "确定性验证：中立树/蓝图 vs 实现侧 DOM/截图的几何/文本命中/溢出/重叠断言（doc14 §5），与 anti_hack_scan 互补，Phase6 验证前调用。",
    parameters: {
      neutral: { type: "json", description: "中立树（neutralTree）或 null" },
      blueprint: { type: "json", description: "blueprint 对象或 null" },
      domDump: { type: "json", description: "browser_dom_dump 输出" },
      implementedTree: { type: "json", description: "实现树（page_layout_tree 输出）" },
      tolerance: { type: "number", description: "几何容差 px，默认 2" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    isConcurrencySafe: () => true,
    execute: async (args: any) => verifyNeutral(args) as any,
  }));

  // ── Viewport/State 矩阵（doc13 §5.1） ─────────────────────────────────
  ctx.tools.register(defineTool({
    name: "viewport_matrix",
    description: "展开多视口×多状态矩阵（笛卡尔积）并聚合评分。输入 viewports/states，输出 {key:viewport-state} 列表与聚合分，供 Phase3/6 多视口验证。",
    parameters: {
      viewports: { type: "json", description: "视口数组，如 [{name:'desktop',width:1440,height:900}] 或 ['desktop','mobile']，默认 desktop/tablet/mobile" },
      states: { type: "json", description: "状态数组，如 ['default','hover','active']，默认 default/hover/active/disabled" },
      results: { type: "json", description: "可选：已有的逐项分数 [{key,viewport,state,score:{total}}]，传入则直接聚合" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => {
      const matrix = expandMatrix({ viewports: args.viewports, states: args.states })
      if (args.results) {
        const agg = aggregateMatrixScores(args.results)
        const resp = checkResponsive(args.results)
        return { matrix, aggregate: agg, responsive: resp } as any
      }
      return { matrix, count: matrix.length } as any
    },
  }));

  // ── Token 映射（Phase2 仓库映射：复用项目 tokens） ─────────────────
  ctx.tools.register(defineTool({
    name: "token_map",
    description: "设计令牌映射：blueprint 的 typographyProfile/palette vs 项目已有 tokens，输出 reuse/near/create 建议（ΔE≤3 复用）。供 Phase2 复用资产决策。",
    parameters: {
      typographyProfile: { type: "json", description: "blueprint.typographyProfile" },
      palette: { type: "json", description: "blueprint.palette" },
      projectTypography: { type: "json", description: "项目已有字体 tokens [{name,family,size,weight,cssVar}]" },
      projectPalette: { type: "json", description: "项目已有色板 [hex]" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => {
      const typo = args.typographyProfile ? mapTypographyTokens(args.typographyProfile, args.projectTypography || []) : []
      const pal = args.palette ? mapPaletteTokens(args.palette, args.projectPalette || []) : []
      return { typography: typo, palette: pal, summary: { typoReuse: typo.filter(t=>t.action==='reuse').length, palReuse: pal.filter(p=>p.action==='reuse').length } }
    },
  }));

  // ── Guard: design_constraints（Design System 约束） ─────────────────
  ctx.tools.register(defineTool({
    name: "check_design_constraints",
    description: "设计约束校验：候选值 {prop,value,path} 是否贴合项目 spacing/color/typography/radius scale（与 anti_hack_scan 互补），阻断任意值。",
    parameters: {
      prop: { type: "string", required: true, description: "属性名，如 gap/padding/color/fontSize" },
      value: { type: "json", required: true, description: "候选值" },
      path: { type: "string", description: "节点路径" },
      constraints: { type: "json", description: "{spacingScale:[], colorPalette:[], typographyScale:{sizes,weights,families}, borderRadiusScale:[]}" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => checkDesignConstraints({ prop: args.prop, value: args.value, path: args.path }, args.constraints || {}) as any,
  }));

  // ── Guard: a11y（可访问性） ───────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "check_a11y",
    description: "可访问性校验：语义标签/alt/标题层级/对比度（WCAG AA 4.5:1），Phase6 验证与 anti_hack/verify_neutral 互补。",
    parameters: {
      tree: { type: "json", description: "实现树（page_layout_tree 输出）" },
      domDump: { type: "json", description: "browser_dom_dump 输出（二选一）" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => checkA11y(args) as any,
  }));

  // ── Recovery / CI ──────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "recovery_plan",
    description: "容错恢复：对 devServer/browser/network/file 错误分类并给出重试/降级建议（与 selfcorrect 的视觉回滚互补）。",
    parameters: {
      error: { type: "json", required: true, description: "错误对象或消息，如 {message:'ECONNREFUSED'}" },
      attempt: { type: "number", description: "已重试次数，默认 0" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => recoveryPlan(args.error, args.attempt || 0) as any,
  }));

  ctx.tools.register(defineTool({
    name: "ci_report",
    description: "CI 报告：基于 state 的阈值门禁（S≥0.96 无 P0/blocked）+ core 蓝图四闸（meta.gates 任一 FAIL 直接不通过）与 artifacts 归档，输出 report.json/md 供 CI 门禁。",
    parameters: {
      state: { type: "json", required: true, description: "UI Reconstruction State（state.json 内容）" },
      blueprint: { type: "json", description: "core 蓝图（blueprint.json 内容）——读取 meta.gates 四闸并入 CI 门禁，任一 FAIL 即判不通过" },
      artifacts: { type: "json", description: "artifacts 路径数组" },
      outDir: { type: "string", description: "输出目录，默认 .ui-reverse/ci" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => {
      const report = buildCiReport({ state: args.state, blueprint: args.blueprint, artifacts: args.artifacts || [] })
      const files = writeCiArtifacts(report, { outDir: args.outDir || '.ui-reverse/ci' })
      const gate = ciGate(report)
      return { report, files, gate } as any
    },
  }));

  // ── Security / Git ─────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "check_dsl_security",
    description: "安全校验：DSL 文本/URL/SVG 的 XSS 与非 allowlist 资源检查（输入侧守卫，与 anti_hack 输出侧互补）。",
    parameters: {
      dsl: { type: "json", required: true, description: "MasterGo DSL 或中立树对象" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => checkDslSecurity(args.dsl) as any,
  }));

  ctx.tools.register(defineTool({
    name: "git_rollback_point",
    description: "Git 锚点：读取当前 HEAD 与工作区状态，生成 rollbackPoints 条目（与 state.rollbackPoints 联动，Phase5 改前记录）。",
    parameters: {
      cwd: { type: "string", description: "仓库路径，默认 cwd" },
      iteration: { type: "number", description: "当前迭代轮次" },
    },
    output: { schema: { type: "json" }, render: renderJson },
    execute: async (args: any) => ensureRollbackPoint({ iteration: args.iteration ?? 0 }, args.cwd || process.cwd()),
  }));

  // ── 生命周期：浏览器 / dev server 随插件 fiber 走 ──
  // 此前两者是模块级单例，插件 reload/卸载不清理。官方 defensive-patterns 要求
  // "Dispose must reach quiescence"（kill → await done），此处作为 cordis effect
  // 注册：fiber 卸载时整组杀 dev server 并关闭浏览器，await 全部退出。
  // （ctx.jobs 后台任务运行时在宿主 0.1.2+ 才提供，届时可迁移。）
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => async () => {
        const d = devServerInstance;
        devServerInstance = null;
        try { await d?.stop() } catch {}
        try { await browser.browserClose() } catch {}
      }, 'ui-reverse-agent:browser-devserver-teardown');
    }
  } catch {}
}

export { name, inject, apply, PROMPT_TEMPLATE, Config, applyConfig, runtimeConfig, initStorageBackend, storageBackendName };
export { referenceIngest } from "./perception/reference.ts";
export * from "./perception/browser.ts";
export * from "./perception/neutral-ingest.ts";
export * from "./perception/viewport-matrix.ts";
export * from "./services/devserver.ts";
export * from "./services/job-devserver.ts";
export * from "./services/lsp-map.ts";
export * from "./services/storage.ts";
export * from "./services/token-map.ts";
export * from "./services/cache.ts";
export * from "./services/large-file.ts";
export * from "./services/ci.ts";
export * from "./services/git.ts";
export * from "./services/cjk.ts";
export * from "./services/animation.ts";
export * from "./services/ask-user.ts";
export * from "./memory/state.ts";
export * from "./guard/fanout.ts";
export * from "./guard/verify-neutral.ts";
export * from "./guard/design-constraints.ts";
export * from "./guard/a11y.ts";
export * from "./guard/recovery.ts";
export * from "./guard/security.ts";
