# 19 — 收敛内聚与模块复用方案

日期：2026-08-29
状态：方案（待逐项执行）
前置：doc16/17（架构与实施）、doc18（DSH seams）；本文回答"代码层怎么收敛内聚、模块怎么真正复用"。

---

## 一、现状盘点（全部经 grep/diff 实证）

### 1.1 根因：引擎三代同源、两代分叉（P0）

ui-restore 是从 kit（@3kaiu/dsh-plugin-kit）+ layout-infer 复制出源码后独立进化的 v2，期间从未回灌，且对 kit **零依赖**（`packages/ui-restore/package.json` 无 `@3kaiu/dsh-plugin-kit`）。形成三组分叉：

| 文件族 | kit 侧正本？ | ui-restore 侧 | 分叉状态 |
|---|---|---|---|
| `layout-core.ts` | `shared/src/layout-core.ts`（764 行） | `ui-restore/src/layout-core.ts`（1534 行） | ~390 行逐字重复；ui-restore 多 ~770 行新逻辑（inferGridPattern/inferStaggeredDeck/system-chrome 等）；**反向**漂移：shared 版 `inferLayout` 多了 `tolerance/absolutesWhitelist` 参数（shared/src/layout-core.ts:88-89），ui-restore 版没有。ui-restore 版头注释仍写"位于 @3kaiu/dsh-plugin-kit"（src/layout-core.ts:19）——已失实 |
| `classify.ts` | `layout-infer/src/classify.ts`（294 行） | `ui-restore/src/classify.ts`（370 行） | ~284 行同源；两者各 import 各的 layout-core，同一套分类逻辑跑在两个已分叉的引擎上。ui-restore 版 doc16 已定性："classify 自 layout-infer 壳包归位 core" |
| `dsl-clean.ts` | `shared/src/dsl-clean.ts` | `ui-restore/src/dsl-clean.ts` | **语义已分叉**：shared 版角色判定靠文本特征（`学单词/课程/直播` → learn-card/content-tabs，app 专属、语言绑定）；ui-restore 版已演进为纯几何判定（segmented-bar/feature-card/grid-row/card-deck + `_repeatGroup` 折叠 + system-chrome + `CONTAINER_ABSORB_RATIO=0.95` 归一）——方向上 ui-restore 版是正确演进（语言无关、可泛化） |

结论：**ui-restore 侧是 v2 正本**（超集、更通用），但 shared/layout-infer 侧仍有一个反向改进（`tolerance` 参数）未被 v2 吸收。任其继续，两代引擎行为差异会越来越大且无人察觉。

### 1.2 工具函数重复矩阵（含已漂移项）

| 函数 | 副本数 | 位置 | 漂移风险 |
|---|---|---|---|
| `esc`/`escAttr`（HTML 转义） | 6+ | `ui-restore/src/emit/{html,react,tailwind,vue,miniprogram}.ts` + `ura/src/adapters/{vue,react}.ts` | **强**：`ui-restore/src/emit/vue.ts:14` 的 `escAttr` 只转义 `"`；ura 版还处理 `[;{}\\<>]`。强度不一 |
| `flag()`（CLI 参数解析） | 5 | `ui-restore/src/adapters/{cli,restore,loop,dom-blocks,screenshot}.ts` | **强**：cli/restore 版识别布尔旗标与 `--` 前缀；loop/dom-blocks/screenshot 版盲目取下一 argv。同名不同义 |
| `readJson` | 3 | `adapters/pipeline.ts:20`（裸读）、`target/detect.ts:12`（try/catch、无边界）、`adapters/mcp-server.ts:33`（confineUnder 收容） | **安全相关**：只有 MCP 路径有收容 |
| 路径收容 | 2 | `src/path-guard.ts:11-17`（throw）vs `target/asset-resolver.ts:176-181`（返回 null） | 语义重复，缺 `confineOrNull` 变体 |
| session load/save | 2 | `adapters/restore.ts:47-61`（裸 fs）vs `adapters/mcp-server.ts:61-67`（收容） | 与上同：收容不一致 |
| `round1` | 10 | ui-restore 8 处 + shared 2 处 | `ir/outline.ts:7` 写成 `*100/10/10`（数值恰等，风格已散） |
| `TOL = 2` | 5 | shared×2、ui-restore×2、ura/config.ts:10 | 中 |
| CJK 判定/宽度 | 3 | `ura/src/services/cjk.ts:4`、`llm/src/sse.ts:156-167`、`ui-restore/src/text-metrics.ts:74` | **行为分叉**：sse 的码点区间漏 kana/全角（0x3040-30FF、0xFF00-FFEF），三处 token/宽度模型各异 |
| `mockFetch`（测试） | 2 手写 | `llm/test/error-classify.test.ts:23` == `rate-limit.test.ts:23` | shared/src/test-utils.ts:19 已有同实现但**零消费者** |

### 1.3 死代码清单（export 了但无人 import，已逐一验证 0 引用）

- ura 死 shim ×7：`src/measure/{typography,dom-to-layout,compare}.ts`、`src/compare/{pixel,align}.ts`、`src/guard/{antihack,selfcorrect}.ts` —— 全是 `export … from "@3kaiu/dsh-plugin-kit"` 一行壳，index.ts 未引用。另 3 个 shim 是活的（geometry/score/palette）。
- `shared/src/test-utils.ts`：仅被 index.ts re-export，无真实消费者（其 mockFetch 在 llm 测试里被手写了两次）。
- shared 部分死导出（shim-only）：`selfcorrect.ts` 全模块、`score.ts:quickScore`、`palette.ts:{parseColor,extractPaletteFromTree}`、`dom-to-layout.ts:{parseGap,isVisibleNode}`。注意：kit 是已发布包，删公共 API 属 breaking，需major 版本决策。
- build.mjs 死孪生 ×4：`layout-infer`、`shared`、`ura`、`llm` 四包 package.json 均接 `tsx build.ts`，同名 `build.mjs` 未接任何 package.json script（其中 3 份被 agent-loop.yml 直呼 —— 实施时已同步把 CI 切到 `pnpm build` 后删除；ura 的 .mjs 孪生已实际漂移：缺 build.ts 后来加的 zod external）。另 `llm/build.ts:51-59` 手抄了 DSH 外部列表子集，未复用 `scripts/esbuild-common.mjs` 的 `DSH_EXTERNALS`，可漂移。

### 1.4 脚手架/脚本重复（P2）

- `layout-infer/scripts/verify-{gaiban,gaiban2,demo,neutral}.mjs` 四份 89–155 行脚本共享 78–118 行同一"载入→装配→clean→重渲染→bbox 校验"循环，容差与步骤各自漂移；`shared/test/verify-clean.ts` 是第五份同模式。
- `scripts/install-local.mjs`（157 行）的 `--release` 模式与 `install-remote.mjs`（167 行）约 55 行重复；`run-visual-loop.mjs` vs `run-visual-loop-batch.mjs` 同脚手架。

---

## 二、方案

### 2.1 方向决策（需拍板）

**D1 — 引擎正本归属**（对应 §1.1，本方案最大项）：
- **甲（推荐，正解）**：kit 持有引擎超集。将 ui-restore 的 layout-core/classify/dsl-clean 合并回 `@3kaiu/dsh-plugin-kit`（吸收 shared 版 `tolerance/absolutesWhitelist` 参数做双向合并），ui-restore 加 kit 依赖、删除本地三份分叉，emit/adapter 留在 ui-restore。验收门禁：layout-infer 测试 + ui-restore layout-core/dsl-clean 测试 + benchmark 2 案例全绿。工程量大（数值代码，需谨慎），建议专项批次做。
- **乙（止血）**：声明"ui-restore 侧为 v2 正本"，shared/layout-infer 两份文件头加冻结声明 + 指向正本的注释，加契约哨兵测试锁定两侧公共函数签名。1 小时级，防继续漂，不消除分叉。
- 建议：先乙后甲——第 2 批落地乙，第 3 批（专项）做甲。

**D2 — kit 公共 API 死导出**（§1.3）：`selfcorrect` 等删除属 breaking change。选项：留待 major / 立即删并升 0.x minor（0.x 阶段按惯例允许）。需拍板。

**D3 — 13 个未推送 commit**：与本任务无关但悬置，是否先 push。

### 2.2 批次计划（沿用"逐项进行"节奏）

**第 1 批 — 零风险清理 + 安全一致性（P0，半天内）**
1. 删 ura 7 个死 shim、4 个 build.mjs 死孪生。
2. `llm/build.ts` 外部列表改 import `scripts/esbuild-common.mjs` 的 `DSH_EXTERNALS`。
3. ui-restore 内部收敛：`flag()`×5 → `adapters/args.ts`（取 cli 版守卫语义为准）；`readJson`×3 → `src/fs-util.ts`（`readJsonStrict`/`readJsonTolerant` 两变体。实施修正：收容留在入口适配层 —— 库层收容会打断 benchmark/CLI 的收容根外合法路径；MCP 入口已全部收容）；`confineOrNull` 并入 path-guard（asset-resolver 的本地 confine 改引，宽容变体含"rel=根本身拒绝"语义）；session load/save 收敛为 `src/session-store.ts`（restore 的缺文件自建骨架语义用 `create` 选项保留）。
4. `emit/vue.ts` 的 `escAttr` 升级为强转义（与 ura 版对齐），emit 侧统一走新建 `emit/escape.ts` 单一来源。
5. 测试真用 `shared/test-utils.ts` 的 `mockFetch`（llm 两处手写迁过去）——kit 导出从死变活，优于删除。
6. 实施附加修复：多入口 split 使 screenshot.ts 被 dom-blocks 引用而整体进共享 chunk，`dist/screenshot.js` 直跑失活 —— 抽出 `adapters/browser-launch.ts` 共享层，screenshot.ts 还原纯 CLI 叶入口。

**第 2 批 — 常量与语义收敛 + 分叉显式化（P1）**
1. 方案乙落地：三组分叉文件头加"正本/冻结"声明 + 公共函数签名契约哨兵测试。
2. `round1`/`TOL` 收敛进 kit 并全量替换（round1 ×10、TOL ×5）。
3. CJK 单一来源：kit 新增 `typography/cjk.ts`（取三处字符类并集：kana + CJK 统一表意 + 兼容表意 + 全角形式 + CJK 标点），`sse.ts` 分词、`text-metrics.ts` 宽度、`ura/services/cjk.ts` 三处改引——顺带修复 sse 漏 kana/全角的行为分叉。
4. ura react/vue 适配器抽公共 `neutralToDom` walker（num/tag 映射/walk 骨架单份，只留 per-framework style 序列化差异）。

**第 3 批 — 引擎归一专项（D1 甲，需整段时间）**
实施记录(2026-08-29): 已完成, 采取了"分层切割"而非整文件吸收 ——
1. v2 layout-core 依赖 design-tokens/text-metrics/yoga-truth/scale 四个增强层(opentype/yoga 重运行时依赖), 整文件进 kit 会把重依赖拖给所有 bundle kit 的插件。故按依赖线切割: **kit 持纯引擎切片**(inferLayout+tolerance/simulateFlex/cluster/grid 几何/样式解析 + reconstructHierarchy/ROLES 附录), ui-restore 留 `blueprint-engine.ts`(reverseInfer→sanitize→generate→自愈/守恒, 引擎函数全部自 kit 导入)。
2. kit 吸收 v2 的 dsl-clean(几何角色)/classify/repeat/system-chrome; layout-infer classify 改为 kit 再导出(壳包定性落地); kit 版本 0.1.0→0.2.0。
3. ui-restore 删除本地 5 份引擎文件, index 按兼容面精确再导出(不 export * 整个 kit, 防 semaphore/test-utils 等进入公共 API), kit 以 devDependency 进构建期 bundle(与 ura/layout-infer 同模式, 运行时零新依赖)。
4. 两项语义裁决随归一定型(双侧测试同步): (a) kit 基底的 inferGrid wrap 回退被 v2 裁决移除(伪 wrap 破坏几何守恒, "抖动网格"用例双侧同语义); (b) v2 spacing 语义下不等间距容器凭 per-pair spacing 通过守恒转正 flex(layout-infer fixture flex 16→19)。
5. 门禁: 全仓 build+test 全绿(含 fork-parity 哨兵, 分叉归一后自动退化为同一性校验), benchmark 2 案例数值与基线逐项一致。

**第 4 批 — 脚本去重（P2）**
实施记录(2026-08-29):
1. 已做: layout-infer 浏览器族 verify 三连(gaiban/gaiban2/demo)抽 `scripts/verify-lib.mjs` —— Chrome 探测(修掉 3 处硬编码 macOS 路径, 换机器/CI 即失效的典型拷贝漂移)/启动/网络空闲/canvas 原点/截图/关会话单点维护; 文本探针等 fixture 专属断言留在各脚本(强行合一只有间接成本)。verify-neutral 是纯 JSON 中立性扫描, 与浏览器族不同族, 保持独立。注: /tmp/pw(playwright-core dev 安装)不在时浏览器探针不可运行, 改动经语法校验 + 机械映射评审。
2. 暂缓(决策记录): install-local `--release` 与 install-remote 去重、run-visual-loop 双子去重 —— 两者是部署关键路径, 本环境无法端到端验证 dsh 宿主安装流; 收益(~55 行)低于引入回归的风险, 留待下次需要改这两个脚本时顺路抽取。
3. shared/test/verify-clean.ts 与四连脚本同模式但属测试断言(有独立容差语义), 不强行共用 verify-lib。

### 2.3 验收口径

- 每批结束：`pnpm build && pnpm test` 全绿 + 涉及包的基准/冒烟不回归。
- 第 3 批额外：benchmark 2 案例指标逐项比对留痕（同 doc16 的真值门禁）。
- 复用度度量：收敛后 grep 断言——`round1 =` 全仓源码仅 kit 1 处定义、`const esc =` 仅 escape.ts 1 处、`confineUnder` 仅 path-guard/fs-util、ura 无一行壳 shim、ui-restore/package.json 出现 `@3kaiu/dsh-plugin-kit`。

---

## 四、与非目标的关系

- SSRF 加固（screenshot/browser URL 校验、DNS 解析级 IP 校验）保持独立 backlog 项，不并入本批——本批只处理与"读文件收容一致性"直接相关的部分（readJson）。
- tsc ~720 类型错误清理、UA 伪装决策、storage patch 启用等既有 backlog 项不变。
