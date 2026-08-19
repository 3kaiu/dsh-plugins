# mg-demo-2025 — MasterGo MCP 官方 demo 设计稿 fixtures

> 来源:https://mastergo.com/goto/VoOP3Eis?page_id=40:223&layer_id=755:01774&file=199505469175552&devMode=true
> 文件:`MasterGo MCP 介绍文档`(file_id `199505469175552`,根节点 `755:01774`)
> 拉取方式:MasterGo MCP HTTP 端点(`https://mastergo.com/mcp/*` + `X-MG-UserAccessToken`),即 magic-mcp 内部协议,见下方"接入备忘"。

## 画布

- 尺寸 **1440 × 3923**,背景 `#FCFCFD`(`paint_755:01780`)
- 风格:editorial 长文页,13 个 section,2 个 ambient 光晕装饰越界(off-canvas)

## Section 清单(sections-list.json)

| idx | id | name | 位置/尺寸 | 内容 |
|---|---|---|---|---|
| 0 | 755:01782 | ambient-light-1 | 1200×1200 @-100,-200 | 背景光晕(越界装饰) |
| 1 | 755:01794 | header | 1200×48 @120,80 | brand(icon+title+subtitle) + version-pill(status-dot + "2.0") |
| 2 | 755:02050 | hero-section | 1200×367 @120,208 | 两行标题(第二行蓝紫渐变)+ 描述 |
| 3 | 755:02196 | divider | 1200×12 @120,655 | line + asterisk icon-box + line |
| 4 | 755:02216 | setup-section | 1200×509 @120,747 | Phase 1:section-header + 三步步骤 + dark-terminal(mac 点 + 代码) |
| 5 | 755:03237 | divider | 同上 | — |
| 6 | 755:03256 | capabilities-section | 1200×1010 @120,1428 | Phase 2:9 张能力卡(create/library / read/update/replace / delete/diff/sync/share) |
| 7 | 755:04347 | divider | 同上 | — |
| 8 | 755:04365 | section-header | 286×86 @120,2610 | Phase 3:Conversational UI |
| 9 | 755:04441 | chat-col-1 | 580×1067 @120,2776 | 对话卡片(avatar+meta+bubble,含 status 行) |
| 10 | 755:05151 | chat-col-2 | 580×1067 @740,2776 | 同上(40 节点,ssc=1) |
| 11 | 755:05905 | ambient-light-2 | 1000×1000 @640,360 | 背景光晕 |
| 12 | 755:05915 | ambient-light-3 | 800×800 @144,3033 | 背景光晕 |

## 关键布局语义(cleanToStandardDsl 清洗结果)

- **header**:row,ai=center;brand-group(row,ai=center)+ version-pill(row,jc=center,pad 10/20)
- **hero**:column,ai=center;title-group 两行标题,第二行 `linear-gradient(90deg,#2563EB,#8B5CF6)`
- **divider**:line(570×0)+ icon-box(60×12)+ line,icon-box pad 0/24
- **setup-section**:section-header(column)+ setup-layout(row,ai=center,640 起 terminal 列)
  - steps-container(column,3 步,每步 row:step-num 48×48 渐变底 + step-content column)
  - dark-terminal `#101827` pad 24:mac-header(dots 3 色点)+ code-body(代码块 `#B1C1E2`)
- **capabilities-section**:capabilities-grid(column,3 行)
  - 行1:card-create 580×357(icon-box 80×80 `#EFF6FF` + text-group),card-library 580×325
  - 行2:三卡 373×234,pad 48,icon 28×28
  - 行3:四卡 282×173,pad 32,icon 20×20
  - 卡内 icon-box 均为浅色圆角底 + 深色 PATH 图标
- **chat 区**:row-group 1200×1067(row,gap 40,ai=center);每列 chat-card(FRAME 白底)内含 chat-header(avatar 48×48 `#EFF6FF` + meta)+ chat-bubble(pad 32,`#FCFCFD`,含 status 行)

## classifyDsl 统计(完整 DSL,222 节点)

- containers 118 / texts 65 / icons 19 / shapes 20 / absolute 3 / flow 219
- assets:inlineSvg 19(完整 `<svg>` 已生成,含 fill 解析)、images 0、texts 65
- 结论:本稿**无位图资产、无绝对定位 hack**,全部可 flex/flow 还原,是理想的标准 demo 参照

## 文件说明

- `dsl-full.json` — `mcp/dsl` 整根 DSL(styles+nodes+components,119KB)
- `sections-list.json` — `mcp/design-sections` section 列表(含根元信息)
- `mg-demo-sec-N.json` — 13 个 section 的完整 DSL(sectionIndex 0-12)
- `stacked-draft.json` — 组装好的"拍平稿"输入(sections + 各自 dsl),可直接喂 `clean_layout`

## 接入备忘(MCP 驱动方式)

magic-mcp 内部协议(无需本地起 MCP server,HTTP 直调即可):

```
GET https://mastergo.com/mcp/meta?fileId={file}&layerId={layer}
GET https://mastergo.com/mcp/dsl?fileId={file}&layerId={layer}
GET https://mastergo.com/mcp/design-sections?fileId={file}&layerId={layer}[&sectionIndex=N]
Header: X-MG-UserAccessToken: mg_xxx
```

- `design-sections` 无 sectionIndex → section 列表;带 sectionIndex(0..total-1)→ 单个 section 完整 DSL
- 注意:`mastergo.com` 主域可达;`openapi.mastergo.com` 在本沙箱 TLS 被拦,勿用
- token 归属:mcp 侧为 `X-MG-UserAccessToken`;SSE 方式为 `x-mg-useraccesstoken`

## 已知问题(反馈给 layout-infer)

1. `describeStructure` 在 padding 非数组(如 `"10px 20px"` 字符串)时抛
   `A.padding.join is not a function` —— 本 demo 的 version-pill 就带字符串 padding,
   属真实触发路径,需修复(格式化前统一 normalize padding)。
2. divider 的 `line` 节点 height=0 时正常输出,但描述文本中 570x0 可读性差(建议 0 高节点标记为 hairline)。