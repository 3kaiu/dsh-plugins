---
name: ui-restore
description: UI 1:1 还原。设计稿 DSL → 中立蓝图 → 验证门禁。当需要把设计稿(MasterGo/同类导出)还原为代码、或验证生成 UI 与设计稿的一致性时使用。
---

# UI 1:1 还原(六段工作流)

只负责:设计稿 → 描述产物(中立蓝图+产物包) → 验证。代码生成由你按目标技术栈实现。

```
取数① → 归一② → 产物包③ → 实现合同④ → 渲染验证⑤ → 差异定位⑥
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
- 判定:blockMatchRate 必须=1;diffRatio 仅允许文字亚像素/抗锯齿级(<2%)

## ⑥ 差异定位(失败时)

```bash
ui-restore regions <truth.png> <render.png> --bp <blueprint.json>
```

输出差异区域聚类(按像素量降序)+ 每区域相交的蓝图节点候选(id/name/text)——直接指到"哪个节点没还原对",修码后重跑⑤直到收敛。

## 判定标准(1:1 的定义)

- 合同 100% 落地(checklist 无遗漏项)
- 四闸全 PASS(契约/几何/样式守恒/真值)
- blockMatchRate=1 且像素残差仅渲染噪声级
