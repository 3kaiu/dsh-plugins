---
name: ui-restore
description: UI 1:1 还原。设计稿 DSL → 中立蓝图 → 验证门禁。当需要把设计稿(MasterGo/同类导出)还原为代码、或验证生成 UI 与设计稿的一致性时使用。
---

# UI 1:1 还原(六段工作流)

只负责:设计稿 → 描述产物(中立蓝图+产物包) → 验证。代码生成由你按目标技术栈实现。

```
取数① → 归一② → 产物包③ → 实现合同④ → 渲染验证⑤ → 差异定位⑥
```

## 原则(优先级从高到低, 冲突时按序裁决)

- Design Truth > LLM Assumption:蓝图数值是设计稿测量事实, 禁止修改、取整或凭感觉"合理化"
- Visual Fidelity > Code Elegance:不为组件抽象/复用/代码优雅牺牲视觉还原度;Flex 无法准确表达时用 absolute 是正确答案
- Actual Rendering > Source Code Appearance:验收看截图 diff, 不看代码"看起来对"

## Workflow 入口(推荐)

```bash
# 分析: 设计稿 json → UI Truth 产物包 + 四闸门禁(session 记账)
node adapters/restore.mjs analyze <design.json> --dir <out> [--scale auto] --session s.json
# 画像: 项目 → Target Profile(置信度排序，未知=unknown)
node adapters/restore.mjs profile <projectDir> --out profile.json
# 生成: 蓝图 + 画像 → Generation Contract + Asset  → React/HTML 双 serializer + DOM Map
node adapters/restore.mjs generate <blueprint.json> --project <dir> --profile profile.json [--assets assets.json] --out restore
# 对比: 参考图 vs 渲染截图 → 差异区域 + 修正指令 + 组合门禁 + 收敛评分 + iteration 记账
#   成对提供 --blocks-truth/--blocks-render 即启用块级层(blockMatchRate); 记账含防退化:
#   质量键[区域数,标记占比,diffRatio]字典序 + Score 单调收敛，劣化轮次拒绝并要求回滚到最佳轮(session.best + best-render-N.png 存证)
node adapters/restore.mjs verify <truth.png> <render.png> --bp <blueprint.json> [--blocks-truth mT.json --blocks-render mR.json] --session s.json
# 组合门禁单验(供 CI): global+region+geometry 组合，任一 FAIL 即整体 FAIL
node packages/ui-restore/cli.mjs gate <truth.png> <render.png> --bp <blueprint.json>
# 收敛编排(受限 Repair 循环): Region→Node→Source 定位 → PatchContract → 受限 LLM → Validator → Score
node adapters/loop.mjs --bp <blueprint.json> --map <restore/.restore-map.json> --truth <truth.png> --render <render.png> --project <dir> [--max 8]
# 编排推进(V1.5): 确定性状态机 —— 依会话给出 phase 与下一步动作(analyze→implement→correct→done/report), 不内置 LLM
node adapters/restore.mjs restore [design.json] --session s.json
# 截图(可选能力, 需 pnpm add -D playwright && npx playwright install chromium):
node adapters/screenshot.mjs <url-or-file> <out.png> [--width 375] [--height 812]
# Web 渲染探针: 同一会话产出 文本块清单 + 同源截图(png 与块坐标严格同空间):
node adapters/dom-blocks.mjs <url-or-file> <out.blocks.json> [--png <out.png>] [--width 375] [--height 812] [--engine auto|playwright|cdp]
```

MCP 等价工具:`ui_restore_run`(mode=analyze/verify) / `ui_restore_region`(区域下钻) / `ui_restore_diff` / `ui_restore_profile` / `ui_restore_generate` / `ui_restore_gate`。

Target 层: `src/target/{detect,resolve,contract,asset-resolver,patch}.ts`；Verify 层: `src/verify/{gate,score,errors,vision}.ts`；Emit 层: `src/emit/{style-ir,react,html}.ts`；编排: `adapters/loop.mjs`（含 Vision 3.5 兜底 `diagnoseWithVision`）。

## 修正优先级(差异多于 3 处时按序处理)

```
1.页面尺寸 2.大区块位置 3.宽高 4.Layout 5.Margin/Padding/Gap
6.Typography 7.Color 8.Border/Radius 9.Image裁切 10.Shadow/细节
```

## 前置

- 核心库 `@ui-restore/core`(零宿主依赖);CLI `node <pkg>/cli.mjs`;MCP `node <pkg>/adapters/mcp-server.mjs`(stdio)
- 设计稿输入自适应三种形态:`{meta:{canvas},sections:[{x,y,dsl:{nodes,styles}}]}` / MCP 聚合导出 `{sections:[{x,y,nodes,styles}]}` / 裸 section 数组;canvas 缺省自动推断

## ① 取数(MasterGo MCP)

1. 从链接解析 fileId 与 layer_id/page_id
2. 用 MasterGo MCP 的 section 枚举 + 逐 section DSL 拉取(分页取全,**不可跳过任何 section**)
3. 把各 section 聚合落盘为一个 json(形态 B/C 均可);同时用 mcp_extractSvg 导出矢量备查

## ② 归一(ui-restore 内建)

- 形态自适应入口 `ingestDesignExport` 已内建于 CLI/MCP,无需手工改造数据形状
- @2x/@3x 画板:`--scale <倍数|auto>`;auto=逻辑宽比值×字号簇双证据(单证据不自动采纳);归一后 `canvas.scale={factor,source,confidence}` 记录溯源

## ③ 一键产物包(推荐入口)

```bash
ui-restore build <design.json> --dir <out> [--scale auto]
```

产出分层产物(INDEX.txt 给出阅读地图),按序消费:

| 序 | 文件 | 用途 | 典型大小 |
|---|---|---|---|
| 1 | INDEX.txt | 门禁基线 + 阅读地图 | ~1KB |
| 2 | *.checklist.txt | **还原合同**:实现前必读/实现后自检 | ~3KB |
| 3 | *.outline.txt | 空间结构心智模型(尾部消费指南) | ~10KB |
| 4 | *.blueprint.json | 精确数值,按节点 id 查询 | ~50KB |
| 5 | *.tokens.json | DTCG token,样式优先引用 | 按稿 |
| 6 | *.assets.json | 资源导出表骨架(svgKey/nodeId→实际资源),需回填 | ~2KB |

四道门禁必须全 PASS 才可进入实现:**契约 / 几何守恒 / 样式守恒(styleDiffReport) / Yoga 真值**。任一 FAIL = 蓝图本身失真,勿消费。

## ④ 实现(按还原合同写码)

铁律(全文见 outline 尾部消费指南):
- `layout.role` 定结构(row/column/stack/box);缺省约定:start/gap0/padding 全 0
- `bounds` 是画布绝对坐标且为尺寸唯一真值;子项相对位置=子 bounds−父 bounds
- 层级:`floatings` 在 `tree` 之上;stack 子项按数组序自下而上(z 序)
- 文本:`softWrap:false` 禁止换行;`textRuns` 存在=富文本混排,逐 run 优先
- 样式通道:`color`/`fill`(gradient|image)/`stroke{color,width,align,style}`/`rotation`/`opacity`
- **合同逐项落地**:`*.checklist.txt` 里每个文本/组件组/矢量/位图都必须出现——组件组实现为单组件多实例,禁止逐份拷贝;svgKey 经 assets 表解析,不得用近似图形替代

## ⑤ 渲染验证

- 蓝图侧:`ui-restore verify <blueprint.json>`(契约+真值 PASS)
- 渲染侧:`ui-restore diff <truth.png> <render.png> --blocks <mT.json>,<mR.json>`
  - 渲染器块清单契约:任意能导出 `{png, textBlocks:[{text,x,y,width,height}]}` 的渲染器(Web 截图+DOM 遍历 / Flutter golden 收集 RenderParagraph / 原生快照)接同一内核
- 判定:差异区域归零 + diffRatio 仅允许文字亚像素/抗锯齿级(<2%)
- 块级层:blockMatchRate 以「文本均为真文本节点」的渲染体为满分语义 —— 设计稿文本呈矢量字形(svgKey)时 DOM 无对应文本节点, BMR 天然<1 且不算失败(参考项, 见 §⑦)

## ⑥ 差异定位(失败时)

```bash
ui-restore regions <truth.png> <render.png> --bp <blueprint.json>
```

输出差异区域聚类(按像素量降序)+ 每区域相交的蓝图节点候选(id/name/text)——直接指到"哪个节点没还原对"。提供渲染侧文本块清单时附 `domHints`(区域内 DOM 文本块坐标), 可按文本内容直接定位代码段。修码后重跑⑤直到收敛; **防退化**: session.best 记录历史最佳质量键, 任一轮劣于最佳即要求先回滚(git)再局部重改, 不接受越修越坏。

## ⑥+ Vision 兜底(3.5)

仅当确定性 `gate FAIL` 但 `classifyRegions` 无候选/低置信时触发：`shouldTriggerVision` → `cropPngRegion` 成对裁图 → Vision LLM → `diagnoseWithVision` → 回灌 `PatchRequest.errors`（`[Vision] detail`），走同一受限 Repair 通道。

## 判定标准(1:1 的定义)

- 合同 100% 落地(checklist 无遗漏项)
- 四闸全 PASS(契约/几何/样式守恒/真值)
- blockMatchRate=1 且像素残差仅渲染噪声级

## ⑦ 回归基准(benchmark)

回归案例属**使用侧**资产, 不进 core 包(核心库保持业务中立): 统一放仓库根 `benchmarks/`。每个 case 一个目录:

```
benchmarks/
└── case-<名称>/
    ├── design.json     # 设计稿导出(形态 A/B/C 均可)
    ├── truth.png       # 参考图: 几何快照(snapshot 命令)/设计侧导出图/正确实现截图 三选一
    ├── restore.html    # 正确实现(LLM 按蓝图还原的产物, 技术栈不限)
    └── generated/      # 注入偏差版与迭代截图
```

- 回归 = 对每个 case 重跑 `build` 四闸 + `diff`(blockMatchRate=1, diffRatio<2%)+`regions` 归零
- **一键回归**: `node scripts/run-benchmarks.mjs`(好例收敛断言 + 坏例注入必检出的反假阴性门禁; session/产物记账在 `.dsh/bench/`, 不入 git)
- **判定对象是还原结果而非算法输出**: 新案例先入 benchmarks 再改算法; 任何算法改动跑全量 case 防回归
- 差异修正入口: `regions --bp <blueprint.json>` 输出末尾附修正指令(区域→关联节点→下钻核对), 数值真值始终以蓝图为准
