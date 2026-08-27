# 通用 UI 还原能力:架构审计与演进设计(16)

> 状态:**提案(基于 2026-08 全链路实证后重审)**。前置:12(算法)、13(Agent 设计)。
> 实证基线:四份真实设计稿几何守恒 100%、Yoga 真值 PASS、视觉闭环 diff 0~2%、
> codegen 契约门禁已搭建(16 §5)。

## 0. 五个问题的结论先行

| # | 问题 | 结论 |
|---|------|------|
| 1 | 不只用 dsh,怎么通用化 | **核心已 100% 无 dsh 依赖**(§1 审计),只需把"壳"与"核"拆包 |
| 2 | 编排为 tool/skill/工作流/agent? | 不是单选题,是**分层**:核心=纯库,暴露=CLI+MCP Server,编排=Agent(§3) |
| 3 | 只管 UI 还原、热插拔 | 核心库零宿主状态、四段流水线接口化,任何宿主经薄适配接入(§2/§3) |
| 4 | 中立算法产出描述产物 | 蓝图已是该产物;需**契约化**:JSON Schema + 版本 + 双表征(§4) |
| 5 | 模块划分与开源复用 | 七段流水线,逐模块给出复用地图(§5);已复用 4 个开源包,再补 5 个参照 |

## 1. 耦合审计(实证)

```text
# 现状(2026-08 审计后, 壳核拆分已落地)
packages/ui-restore/src/          # = @ui-restore/core(零宿主依赖, 仅 4 个通用 npm 包)
  layout-core/repeat/yoga-truth/text-metrics/visual-diff/scale/system-chrome    [纯]
  dsl-clean/design-tokens                                                       [纯]
  classify                    ← 自 layout-infer 壳包归位(kind/sizing/position/spacing 决策属算法)
  ir/schema|ingest|outline|checklist                                            [契约层]
packages/shared/src/              # = @3kaiu/dsh-plugin-kit
  quota-tracker/semaphore/test-utils → 宿主设施(UI 核心已全部迁出)              [宿主]
packages/layout-infer/src/        # = @3kaiu/dsh-layout-infer
  index.ts/clean.ts/annotate.ts → @deepseek-ai/dsh-tools defineTool 注册壳        [壳]
```

**结论:UI 还原核心(算法+验证+分类+描述产物)已零宿主耦合且单包自洽。**
宿主耦合只剩工具注册壳(本就该薄)。另据同一轮审计, 编排逻辑已按「单一实现」收敛:
蓝图构建(buildBlueprint)/产物包(writeArtifactBundle, 含 INDEX)/视觉验证(verifyScreenshots)
只存在于 adapters/pipeline.mjs 一份, cli.mjs 与 mcp-server.mjs 一律薄转发 —— 此前三处拷贝
曾出现行为分叉(workflow 主入口缺 INDEX、MCP verify 缺块级指标)。
通用化不是"重写解耦", 是**打包切分 + 单一实现多暴露面**。

## 2. 目标分包(热插拔的物理形态)

```text
ui-restore/
  core/            # 纯库:零宿主依赖,Node>=20,仅 4 个通用 npm 包
    ir/            #   蓝图 Schema(版本化) + 双表征序列化(§4)
    ingest/        #   设计源适配:mastergo.ts(现 dsl-clean+sanitize) / figma.ts(未来)
    infer/         #   布局反推(layout-core) / 重复结构(repeat) / 真值自愈(yoga-truth)
    describe/      #   样式提取 / 设计 token(DTCG) / 文本度量 / 图标引用
    verify/        #   几何守恒(autoHealing) / 视觉对比内核(visual-diff)
  cli/             # `ui-restore blueprint|verify|diff` —— 任何脚本/CI 可用
  adapters/
    mcp-server/    # MCP Server:@modelcontextprotocol/sdk,把 core 能力暴露为标准工具
    dsh-plugin/    # 现 layout-infer 的 defineTool 壳(原样保留,调 core)
  harness/         # Flutter golden 渲染器 + codegen 契约门禁(现 visual-loop/)
  docs/
```

**热插拔语义**:宿主(dsh/其他 Agent/CI)只依赖 `core/ir` 的蓝图契约与适配器暴露的
工具面;核心不持有任何宿主状态(无配额/无会话/无密钥)。换宿主=换 adapters/,
核心与 harness 原样搬运。四段流水线(ingest→infer→describe→verify)各自接口化,
单段可替换(如换 Figma ingest、换 taffy 真值引擎)。

## 3. 编排形态对比(问题 2/3)

| 形态 | 适合谁 | 优点 | 局限 | 判定 |
|------|--------|------|------|------|
| 纯库 | 其他开发者/CI | 零约束、可测试 | 需自己编排 | **地基(必选)** |
| CLI | 脚本/CI/批处理 | 稳定进程边界,语言无关 | 无交互 | **必选(批处理基线已用)** |
| MCP Server | 任意 MCP 宿主(Claude/Cursor/自研 Agent) | 行业标准工具协议,一次实现处处可用;天然回答"不只 dsh" | 需宿主支持 MCP | **推荐的标准暴露面** |
| dsh Tool(现状) | dsh 宿主 | 已工作 | 仅 dsh | 保留为薄壳,调 core |
| Skill | 文件系统型 Agent(.agents/skills) | 指令+脚本自包含,人类可读 | 依赖宿主 skill 机制 | 可选加分项(SKILL.md+CLI 调用) |
| Workflow | 无人值守批处理 | 确定性 | 不灵活 | 即 CLI 的 CI 化,已有雏形(batch) |
| Agent | "只负责 UI 还原"的专职智能体 | 闭环决策(蓝图→生成→验证→迭代) | 复杂度最高 | **编排层**(13 篇已设计),消费 core 工具面 |

**推荐组合**:`core(库) + cli + mcp-server` 为标准三件套;
dsh 壳与 Skill 是同一核心的两个薄适配;Agent(13 篇)站在工具面之上做还原闭环。
**职责铁律:本能力只回答"设计稿→描述产物→验证",代码生成永远在下游 LLM/项目侧。**

## 4. 描述产物契约(问题 4)

蓝图即"描述产物"。契约化三件事:

1. **Schema 版本化**:`BlueprintSchema v1` 出 JSON Schema(draft 2020-12),
   产出即可机检(字段/枚举/单位),LLM 侧可校验后再消费。
2. **双表征**:
   - `blueprint.json`:无损、精确数值(布局/样式/度量/token 别名)——供精确还原;
   - `outline.txt`:缩进树+逐节点一行摘要(现 dsl-clean 的 description 已是雏形)
     ——供 LLM 快速建立空间心智,省 token。
3. **还原指南段**(新增):产物头部附"如何消费本蓝图"的固定说明——
   role/gap/padding 数组约定、bounds 为画布绝对坐标、svgKey 经导出表解析、
   softWrap/maxLines 语义、多状态稿的状态选择提示。LLM 不需要读算法源码即可正确消费。

中立性由既有守卫保证(蓝图禁含技术栈字面量的单测),新增字段一律走中立枚举/数值。

## 5. 模块划分与开源复用地图(问题 5)

七段流水线,每段:职责 / 现状 / 复用。

| 段 | 职责 | 现状 | 开源复用 |
|----|------|------|----------|
| ① 源适配 | 设计稿 DSL → 内部 IR | mastergo 适配(dsl-clean+sanitize) | **Figma-Context-MCP**(GLips,15.7k★)作为 Figma 侧裁剪范式;figma-js;Penpot 开放格式。适配器接口化后逐源补 |
| ② 分层与聚合 | Z 轴分层/背景悬浮/包含森林 | reverseInferSemanticLayout(自研,已实证) | 无直接可复用——这是核心 IP;FigmaToCode 的分组启发式作对照测试集 |
| ③ 布局反推 | 绝对坐标→flex 语义 | inferLayout+真值自愈 | **yoga-layout✅已用**(真值引擎);taffy(grid 需求时再评估);FigmaToCode 启发式移植为对照 |
| ④ 组件识别 | 哪些节点是一个组件 | 三层:源 INSTANCE 优先→重复结构(repeat/detectSharedComponents)→原型角色 | 设计源原生 INSTANCE 信息优先消费(MasterGo DSL 已带,如 Home Indicator);**Rico/Screen2Words** 作语义命名评测数据(可选);命名本身交给下游 LLM |
| ⑤ 样式与 token | 样式提取/去重/中立 token | extractExactStyles+DTCG(design-tokens) | **style-dictionary✅**(DTCG 消费端);tokens-studio 格式互通(Figma 生态事实标准) |
| ⑥ 文本度量 | 实测宽度/换行预测 | opentype.js+启发式兜底 | **opentype.js✅已用**;harfbuzzjs(拉丁 kerning 高精场景再叠) |
| ⑦ 验证门禁 | 几何/真值/视觉/codegen 四道闸 | autoHealing+yoga-truth+visual-diff+Flutter golden | **pixelmatch✅、Design2Code 指标✅(已实现)**;Playwright(Web 渲染器扩展位);swift-snapshot-testing(若扩 iOS) |

复用原则:**真值引擎/度量/像素对比/协议层用开源;布局反推与组件聚合(核心 IP)自研
但用开源实现做对照回归**;凡下游能做的(代码生成/语义命名)坚决不做。

## 6. 迁移路径(不破坏 dsh 现状)

1. **切包**:shared 中 UI 相关 8 文件 → `ui-restore/core`(纯);quota/semaphore 留宿主侧;
   layout-infer 改为调 core 的 dsh 壳。对内 import 路径变更,对外行为零变化(全量回归门禁)。
2. **契约固化**:BlueprintSchema v1 + JSON Schema 校验进单测;双表征序列化器。
3. **CLI**:三个子命令包装现有函数(batch 基线脚本即雏形)。
4. **MCP Server**:@modelcontextprotocol/sdk 暴露 `blueprint/verify/diff/tokens` 四工具;
   dsh 壳与 MCP 壳共用 core,互不感知。
5. **Skill/Agent**:SKILL.md(指令+CLI 用例)与 13 篇 Agent 接入工具面。

每步独立可交付,1~2 是通用化的实质,3~5 是暴露面增量。

## 7. 与既有文档的关系

- 12 篇(算法):核心 IP 的算法细节,本文不重复;
- 13 篇(Agent):编排层的 Agent 设计,本文确认其消费面(core 工具化)不变;
- 11 篇(POC):视觉闭环实证数据,本文 §0 基线引用。
