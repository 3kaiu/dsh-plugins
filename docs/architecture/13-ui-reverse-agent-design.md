# UI 1:1 视觉还原 Agent 设计(13)

> 设计一个**可落地执行的 Visual Reverse Engineering Agent**:输入参考 UI(截图 / 网页 / MasterGo DSL / 多状态 / 多视口),自主分析视觉结构、修改目标项目代码、浏览器截图与视觉对比迭代,直到最大化视觉相似度。
>
> 本文是完整设计文档,不写 UI 代码。文档中的每个组件、工具 schema、阈值、模板都按"直接开工实现"的标准给出。
>
> 基线:复用并改造现有 `@3kaiu/dsh-layout-infer`(几何反推 flex 语义 + 还原决策分类)与 `@3kaiu/dsh-plugin-kit`(`layout-core.ts` 布局内核)。算法细节见 [12-ui-restore-algorithm.md](./12-ui-restore-algorithm.md)。

---

## 0. 总览

### 0.1 目标

让一个 Agent 能在 DSH(Cordis)运行时里:

1. 接收参考 UI(截图文件、MasterGo DSL、或任意 URL)
2. 自动生成 **Visual Blueprint**(布局树 + 排版档案 + 调色板 + 资产清单 + 状态/视口清单)
3. 运行目标项目,建立 Baseline 截图与 DOM 快照
4. 逐轮执行 `对比 → 诊断 → 修改 → 渲染 → 截图 → 再对比`,每轮只处理**影响最大的一个视觉差异**
5. 用确定性工具测量相似度,自纠错(regression 即回滚),反 hack 扫描,直到达到完成条件

### 0.2 运行时形态(推荐)

| 组件 | 形态 | 说明 |
|---|---|---|
| 测量/对比/守卫工具 | **DSH host 插件** `packages/ui-reverse-agent` | 注册 `ctx.tools.register`,复用 `dsh-layout-infer` 的 4 个工具并新增工具 |
| 浏览器自动化 | 插件内置 **Playwright** service | 管理 dev server 子进程 + chromium;工具与浏览器通过 service 交互 |
| Agent 本体 | **Agent preset** `~/.dsh/.agent-presets/ui-reverse/` | system prompt + 工具绑定;消费方 LLM 驱动循环,工具提供确定性测量 |
| 仓库操作 | 宿主已有 `read/write/edit/glob/grep/bash` | 不做包装,直接复用 |

> 为什么是 LLM 驱动循环而不是代码驱动:差异诊断需要视觉理解(看热图、看截图、判断"这是字体问题还是布局问题"),无法纯代码化。代码只负责**确定性测量**,决策归 LLM。可选提供 `auto-pilot` 模式(见 §10.6)用于简单项目。

### 0.3 与 layout-infer 的关系

```
layout-infer(现状, 面向 MasterGo 拍平稿/DSL)
   infer_layout / annotate_layout / clean_layout / classify_design
        │  改造: 输入源扩展 + 新增对比工具 + 参数化容差
        ▼
ui-reverse-agent(目标, 面向"参考 UI ↔ 真实页面"闭环)
   blueprint 构建 / DOM→布局树 / 布局对比 / 几何对比 / 守卫扫描
```

不变式沿用 [12] §0:**视觉保真优先,偏差 > 2px 就降级 absolute,绝不为了"好看的结构"牺牲像素一致**。

### 0.4 控制闭环

```text
Reference UI(截图/DSL/URL/多状态/多视口)
    │  perception.reference_ingest
    ▼
Visual Blueprint ──┐
    │              │ (一次构建, 整轮任务复用)
    ▼              │
Baseline Render ◄──┤  Phase 3
    │              │
    ▼              │
Difference Analysis│  Phase 4
    │              │
    ▼              │
Implement(单假设) ─┤  Phase 5
    │              │
    ▼              │
Render + Screenshot│  Phase 6
    │              │
    ▼              │
Compare + Score ───┘  Phase 7(循环)
    │
    ├─ 提升 → 记入 State → 继续最大差异
    ├─ 持平 3 轮 → 重新诊断,不盲目改
    ├─ 下降 → 定位 regression → 回滚 → 重新验证
    └─ 达标 → 完成报告(含不可消除差异归因)
```

---

## 1. Agent Architecture

### 1.1 分层架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Decision Layer(决策层) — LLM 本体                              │
│   差异诊断分类器 / P0-P3 排序 / 修改方案选择 / 完成判定          │
│   输入: 测量层结构化差异 + 热图 + 截图; 输出: 单假设修改指令      │
├─────────────────────────────────────────────────────────────┤
│ Guard Layer(守卫层)                                          │
│   anti_hack_scan(静态反 hack) / regression 检测 / 回滚调度      │
├─────────────────────────────────────────────────────────────┤
│ Memory Layer(记忆层)                                         │
│   UI Reconstruction State(state.json + history/ + artifacts/) │
├─────────────────────────────────────────────────────────────┤
│ Measure Layer(测量层) — layout-infer 改造                      │
│   blueprint 构建 │ DOM→布局树 │ 布局树对比 │ 几何对比 │ 排版对比   │
├─────────────────────────────────────────────────────────────┤
│ Perception Layer(感知层)                                     │
│   reference_ingest(截图/DSL/URL) │ browser 工具组(Playwright)   │
├─────────────────────────────────────────────────────────────┤
│ Action Layer(执行层)                                          │
│   宿主 repo 工具(read/write/edit/glob/grep/bash) + 浏览器交互    │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 模块职责表

| 模块 | 文件(草案) | 职责 | 关键产出 |
|---|---|---|---|
| Perception.Reference | `src/perception/reference.ts` | 摄取参考输入,构建 Blueprint | `blueprint.json` |
| Perception.Live | `src/perception/browser.ts` | Playwright 封装:启动/视口/截图/DOM dump/伪状态 | 截图 PNG + DOM dump JSON |
| Measure.Blueprint | `src/measure/blueprint.ts` | classify_design + annotate_layout 组装蓝图 | 布局树 + 排版 + 调色板 + 资产 |
| Measure.DomToLayout | `src/measure/dom-to-layout.ts` | DOM dump → 标准 DSL 树(改造核心, §11) | 实现侧布局树 |
| Measure.Compare | `src/measure/compare.ts` | 参考树 vs 实现树 → 结构化差异列表 | mismatch 列表 |
| Compare.Pixel | `src/compare/pixel.ts` | 对齐 + SSIM + 像素差 + 热图 | 分层分数 + 热图 PNG |
| Compare.Score | `src/compare/score.ts` | 加权评分 + regression 检测 | 总分 + ΔS |
| Memory.State | `src/memory/state.ts` | 状态读写(append-only) | state.json |
| Guard.Antihack | `src/guard/antihack.ts` | 静态反 hack 扫描 | 违规列表 |
| Guard.SelfCorrect | `src/guard/selfcorrect.ts` | regression 定位与回滚指令 | 回滚清单 |

### 1.3 数据流(单轮迭代)

```text
browser_screenshot ──► compare_screenshots ──► score_report(总分 + 分层 + ΔS)
                          │
browser_dom_dump ──► page_layout_tree ──► compare_layouts ──► 差异列表(按 P 排序)
                          │                       │
                          ▼                       ▼
                 state.json(更新)          Decision Layer(LLM):
                                              诊断根因 → 选单假设
                                                    │
                                                    ▼
                                         Action: 修改 1 处代码
                                                    │
                                                    ▼
                                         Render → 下一轮
```

### 1.4 关键设计决策

1. **蓝图一次构建,任务全程复用**:Blueprint 是参考侧的"唯一真相快照",避免每轮重复分析参考图;参考侧产物与实现侧产物严格分离(`blueprint.json` vs `dom-layout.json`)。
2. **测量必须确定性**:所有"看起来差不多"的判断交给评分工具;LLM 只读结构化差异与热图,不做目测估算。
3. **每轮单假设**:一次迭代只修一个差异(或一个内聚修改集),保证 regression 可定位、可回滚。
4. **守卫自动挂载**:每次验证前自动跑 `anti_hack_scan`,违规直接拦截,不让 hack 进入计分环节。

---

## 2. Agent System Prompt

以下为完整可粘贴的 system prompt(中文)。`{{PLACEHOLDER}}` 为启动时填充。

````text
# 角色

你是 UI Reverse Engineering Agent,一个专业的视觉还原工程师。

你的唯一任务:根据参考 UI(截图、MasterGo DSL、网页、多状态、多视口),修改目标项目代码,
通过"浏览器截图 + 视觉对比"迭代,最大化目标页面与参考 UI 的视觉相似度。

你的目标是视觉相似度,不是代码质量、不是设计美观度、不是重构。

# 事实来源(最高优先级)

参考 UI 是唯一视觉事实来源。当以下内容冲突时,严格按此顺序裁决:

1. 参考 UI(截图/DSL 中的几何、颜色、文字、间距)
2. 本任务的测量工具输出(评分、热图、差异列表)
3. 目标项目现有代码(仅作为可复用资产,不作为设计依据)
4. 常见 UI 规范、设计系统惯例
5. 你自己的审美判断 —— 永远最后

禁止 redesign。禁止"我觉得这样更好看"。禁止用规范替参考图做决定。

# 像素保真定义

"高保真"意味着以下属性与参考一致(优先级从高到低):

- 页面整体布局:容器结构、页面宽高、Header/Sidebar/Main 区域划分
- 几何:position / width / height / margin / padding / gap
- 排版:font family / size / weight / line-height / letter-spacing / color / transform
- 视觉:color / border / radius / shadow / opacity / blur / gradient
- 资产:icon / image / font(优先复用项目已有资产,参考中有则必须用对应资产,禁止近似替代)
- 对齐、溢出、换行行为

# 工作方式

按 Phase 0-7 推进,详见工作流文档:

- Phase 0 环境发现:先扫描项目、找入口、起 dev server,不摸清项目不许改代码
- Phase 1 参考分析:用 reference_ingest 构建 Visual Blueprint
- Phase 2 仓库映射:蓝图元素 → 现有组件/CSS/资产
- Phase 3 基线渲染:先截图,不许猜
- Phase 4 差异分析:用测量工具生成差异报告
- Phase 5 实现:修一个差异
- Phase 6 验证:重截图、重对比、更新分数
- Phase 7 迭代:直到完成

# 差异优先级

- P0:页面整体布局、容器结构、Header/Sidebar/Main、页面宽高 —— 先修
- P1:组件尺寸、间距、排版、Grid/Flex、对齐
- P2:颜色、边框、圆角、阴影、图标
- P3:1px 级差异、微小 opacity/颜色偏差

永远先处理当前影响最大的视觉差异。每轮只修一个差异(或一个内聚修改集),
不要一次修改大量互不相关的内容。

# 测量纪律

- 所有几何、间距、颜色的判断必须来自测量工具输出(page_layout_tree / compare_layouts /
  compare_screenshots / compare_typography),禁止用眼睛从截图估坐标。
- 修改前先看热图与差异列表,找出最大差异的区域,再决定改哪里。
- 每次修改必须可被测量:改完必须重新截图、重新对比,拿到分数变化,否则视为未完成。

# 反 Hack 禁令(绝对禁止)

禁止以下"假还原"手段:

1. 大量 absolute 定位 / 固定坐标硬编码(参考本身是流式布局时)
2. canvas 绘制整个页面
3. 把参考截图直接作为背景图片
4. 用图片替代真实 UI 元素
5. 隐藏真实 DOM(display:none / opacity:0 遮罩)
6. 针对单一 viewport 堆 media query hack
7. 内联样式 / !important 滥用

目标:真实 UI 结构 + 高视觉还原度。anti_hack_scan 每次验证前自动运行,违规未消除
不得声称完成。

# 代码修改规则

1. 优先复用现有组件、CSS、assets
2. 不随意引入 UI framework
3. 不修改无关业务逻辑、API、数据结构
4. 不为视觉还原破坏功能
5. 不做与任务无关的重构
6. 少用 absolute;必须用时给出理由(如参考本身是贴纸/浮动元素)

# 记忆维护

- 每轮结束必须更新 .ui-reverse/state.json(分数、已解决/剩余差异、本轮修改、回滚点)
- 读取 state.json 开始每轮工作;禁止每轮重新分析整个项目
- 剩余差异列表必须按优先级排序,下一轮从列表头部取

# 自纠错

- 若验证后总分下降(ΔS ≤ -0.02),或出现新的 P0 差异:停止前进
- 定位导致 regression 的修改(查 history/ 变更日志),回滚该修改
- 回滚后重新验证,分数必须回到回滚前水平,才可继续
- 不允许带着明显 regression 继续前进

# 输出协议

每轮结束输出(见 §9 模板):

1. Reconstruction Status —— 当前完成度(布局/组件/文字/色彩 + 总分)
2. Visual Difference —— 当前最大差异(含区域与优先级)
3. Root Cause —— 根因诊断(DOM / CSS / Font / Asset / Viewport / Responsive / 其他)
4. Changes —— 本轮修改(文件 + 具体变更)
5. Verification —— 验证结果(分数变化 + 热图变化)
6. Remaining —— 剩余问题(按优先级排序)
7. Next Action —— 下一轮处理什么

# 完成条件(全部满足才可宣布完成)

- 整体 Layout 高度一致
- 主要尺寸、间距一致
- Typography 接近(同一字体族,字号/行高/字重差 ≤ 1px/1 档)
- Colors 接近(ΔE ≤ 3)
- Components / Assets 正确
- Responsive 行为合理(若参考有多个视口)
- 主要状态一致(若参考有多个状态)
- 无明显视觉差异(总相似度 ≥ {{COMPLETE_THRESHOLD}},且无未决 P0/P1)

无法达到 1:1 时,必须明确说明:哪些差异无法消除、为什么(浏览器渲染差异 / 素材缺失 /
字体缺失 / 技术限制),不许含糊带过。

# 环境参数

- 目标项目:{{PROJECT_PATH}}
- 参考输入:{{REFERENCE_INPUT}}
- 目标视口:{{VIEWPORTS}}
- 目标状态:{{STATES}}
- 完成阈值:S ≥ {{COMPLETE_THRESHOLD}}
````

---

## 3. Required Tools

### 3.1 工具总表

| # | 工具 | 来源 | 模块 | 用途 |
|---|---|---|---|---|
| 1 | `reference_ingest` | **新增** | Perception | 截图/DSL/URL → blueprint.json(布局树+排版+调色板+资产+状态+视口) |
| 2 | `browser_start` | **新增** | Perception | 启动 dev server + chromium;返回 URL 与健康状态 |
| 3 | `browser_viewport` | **新增** | Perception | 设置 viewport + deviceScaleFactor |
| 4 | `browser_navigate` | **新增** | Perception | 导航到目标页 |
| 5 | `browser_screenshot` | **新增** | Perception | 截图(full-page / viewport / element)→ PNG 文件 |
| 6 | `browser_dom_dump` | **新增** | Perception | 结构化 DOM dump:可见元素树 + rect + computed styles 子集 |
| 7 | `browser_state_trigger` | **新增** | Perception | CDP 强制 hover/active/focus/disabled/checked 伪状态并截图 |
| 8 | `browser_console` | **新增** | Perception | console 错误、未加载资源、字体加载状态检查 |
| 9 | `infer_layout` | 现有 | Measure | 单容器 flex 语义反推(保留) |
| 10 | `annotate_layout` | 现有 | Measure | 整树递归标注(保留) |
| 11 | `clean_layout` | 现有(改造) | Measure | 拍平稿清洗;新增 `source:"dom"` 模式 |
| 12 | `classify_design` | 现有(改造) | Measure | 还原决策分类;新增 DOM 输入适配 |
| 13 | `page_layout_tree` | **新增** | Measure | DOM dump → 实现侧标准 DSL 树(与 annotate_layout 输出同构) |
| 14 | `compare_layouts` | **新增** | Measure | 参考树 vs 实现树 → 结构化差异列表 |
| 15 | `compare_geometry` | **新增** | Measure | 蓝图 regions vs 实现侧区域框 → 几何偏差(px) |
| 16 | `compare_screenshots` | **新增** | Compare | 对齐 + SSIM + 像素差 + 热图 PNG + 分层分数 |
| 17 | `compare_typography` | **新增** | Compare | 实现侧文字度量 vs 排版档案 → 逐项偏差 |
| 18 | `compare_palette` | **新增** | Compare | 实现侧主色提取 vs 参考调色板 → ΔE 列表 |
| 19 | `score_report` | **新增** | Compare | 加权总分 + 分层分 + ΔS + regression 标记 |
| 20 | `anti_hack_scan` | **新增** | Guard | 静态反 hack 扫描 → 违规列表 |
| 21 | `state_read` / `state_update` | **新增** | Memory | UI Reconstruction State 读写(append-only) |
| — | `read/write/edit/glob/grep/bash` | 宿主 | Action | 仓库读写(直接复用,不包装) |

### 3.2 关键工具 schema 草案

**browser_dom_dump**(实现侧事实快照,后续所有测量都吃它):

```json
{
  "tool": "browser_dom_dump",
  "input": { "selector": "body", "includeComputed": true },
  "output": {
    "viewport": { "width": 1440, "height": 900, "dpr": 2 },
    "tree": [
      {
        "id": "el-42",
        "tag": "button",
        "selector": "main > .card > button.primary",
        "role": "button",
        "rect": { "x": 120, "y": 340, "w": 200, "h": 48 },
        "text": "立即购买",
        "visible": true,
        "children": [],
        "computed": {
          "display": "flex", "flexDirection": "row", "position": "relative",
          "fontFamily": "Inter", "fontSize": 16, "fontWeight": 600,
          "lineHeight": "24px", "letterSpacing": "0.2px",
          "color": "#1a1a1a", "backgroundColor": "rgba(0,0,0,0)",
          "borderRadius": "12px", "padding": "12px 24px", "gap": "8px"
        }
      }
    ],
    "issues": ["font 'Inter' not loaded (fallback to system-ui)"]
  }
}
```

**page_layout_tree**(改造核心,§11.3):

```json
{
  "tool": "page_layout_tree",
  "input": { "domDump": "<browser_dom_dump 输出>" },
  "output": {
    "canvas": { "width": 1440, "height": 900 },
    "tree": [ "与 annotate_layout 输出同构的标注树:每节点 {id, name, role, layout, suggestedName, children}" ],
    "stats": { "total": 120, "containers": 40, "flex": 35, "absolute": 5 }
  }
}
```

**compare_layouts**(结构化差异 = 决策层的主要输入):

```json
{
  "tool": "compare_layouts",
  "input": { "referenceTree": "<blueprint.json 的 tree>", "implementedTree": "<page_layout_tree 输出>" },
  "output": {
    "matched": 38,
    "missing": [ { "path": "header > nav > logo", "priority": "P0" } ],
    "extra": [ { "path": "body > #debug-panel", "priority": "P2" } ],
    "mismatches": [
      {
        "path": "main > .card-grid",
        "prop": "gap",
        "expected": 24, "actual": 16, "delta": 8, "priority": "P1",
        "confidence": 0.9
      }
    ]
  }
}
```

**compare_screenshots**:

```json
{
  "tool": "compare_screenshots",
  "input": {
    "reference": "artifacts/reference-desktop-1440.png",
    "current": "artifacts/current-desktop-1440.png",
    "mode": "strict"  // strict 要求同视口同比例;auto 先对齐
  },
  "output": {
    "aligned": true,
    "ssim": 0.93,
    "pixelDiffRatio": 0.041,
    "meanAbsDiff": 6.2,
    "heatmap": "artifacts/diff-desktop-1440.png",
    "regionScores": [
      { "region": "header", "priority": "P0", "ssim": 0.81 },
      { "region": "main", "priority": "P0", "ssim": 0.95 }
    ]
  }
}
```

**anti_hack_scan**:

```json
{
  "tool": "anti_hack_scan",
  "input": { "projectPath": ".", "domDump": "<最新 dump>", "reference": "<blueprint 摘要>" },
  "output": {
    "violations": [
      { "rule": "absolute-leaf-ratio", "value": "23/120 = 19.2%", "threshold": "15%", "severity": "blocker" }
    ],
    "warnings": [
      { "rule": "inline-style-count", "value": 17, "threshold": 10, "severity": "warning" }
    ]
  }
}
```

### 3.3 工具实现要点

- 所有工具返回确定性 JSON,不依赖 LLM;截图与热图落盘到 `.ui-reverse/artifacts/`,工具只返回路径。
- `browser_*` 共享一个 Playwright service(单例浏览器实例 + 每任务一个 context),dev server 由 `browser_start` 托管,`browser_stop` 清理。
- 截图统一 `deviceScaleFactor=2` 渲染、按 CSS 像素输出,与参考截图对齐时按 CSS 像素比较。
- `compare_layouts` 的节点匹配:先按 role/name 语义匹配,再按位置最近邻回填,输出未匹配集。

---

## 4. Agent Workflow

### Phase 0 — Environment Discovery

| 项 | 内容 |
|---|---|
| 输入 | 目标项目路径 |
| 动作 | 扫描 package.json/入口/构建脚本;确认 dev server 命令与端口;`browser_start` 启动并验证 URL 可访问 |
| 产出 | `env.json`(框架、入口、端口、dev 命令、目标 URL) |
| 退出条件 | 页面可打开、截图成功 |

### Phase 1 — Reference Analysis(构建 Visual Blueprint)

| 项 | 内容 |
|---|---|
| 输入 | 参考截图 / MasterGo DSL / 参考 URL |
| 动作 | `reference_ingest`:DSL 走 `clean_layout`+`annotate_layout`+`classify_design`;纯截图走视觉分段(§6.3);URL 参考则走与实现侧相同的 `browser_dom_dump`+`page_layout_tree` 管线 |
| 产出 | `blueprint.json`:布局树(标注 flex 语义)+ typography profile + 调色板 + 资产清单(images/icons/fonts)+ regions(P0-P3)+ 状态清单 + 视口清单 |
| 退出条件 | 蓝图所有 P0 区域有对应节点;资产清单明确(缺什么要标注 missing) |

### Phase 2 — Repository Mapping

| 项 | 内容 |
|---|---|
| 输入 | blueprint.json + 项目代码 |
| 动作 | 蓝图节点 → 现有组件/CSS/资产映射表(glob/grep 定位);找不到的标 `unmapped` |
| 产出 | `mapping.md`(每蓝图节点:现有组件 / 现有 CSS / 复用资产 / 待新建) |
| 退出条件 | 每个 P0 节点有明确落点(复用或新建) |

### Phase 3 — Baseline Render

| 项 | 内容 |
|---|---|
| 动作 | 目标视口逐个 `browser_screenshot` + `browser_dom_dump` + `page_layout_tree` |
| 产出 | `artifacts/baseline-*.png`、`dom-layout.json` |
| 退出条件 | 基线截图与 DOM 快照齐全 |

### Phase 4 — Difference Analysis

| 项 | 内容 |
|---|---|
| 动作 | `compare_layouts`(参考树 vs 实现树)+ `compare_screenshots`(参考图 vs 基线图)+ `compare_typography` + `compare_palette` |
| 产出 | `diff-report.md`:按 P0→P3 排序的差异列表,每条含 {区域, 属性, 期望值, 实际值, 偏差, 根因假设} |
| 退出条件 | 差异列表头部清晰(最大差异已知) |

### Phase 5 — Implementation

| 项 | 内容 |
|---|---|
| 规则 | **单假设**:取差异列表头部一项,做最小侵入修改;改前确认 git 状态可回滚 |
| 动作 | 用宿主 repo 工具修改;改后立即 `state_update` 记录变更 |
| 反例 | 禁止"顺手把颜色也调了"这类连带修改 |

### Phase 6 — Verification

| 项 | 内容 |
|---|---|
| 动作 | `anti_hack_scan` → `browser_screenshot` + `browser_dom_dump` → `compare_screenshots` + `compare_layouts` → `score_report` |
| 产出 | 新分数 + ΔS + 新热图 |
| 分支 | ΔS ≥ +0.005 正常前进;−0.02 ≤ ΔS < +0.005 记"无进展";ΔS ≤ −0.02 进自纠错(§7) |

### Phase 7 — Iteration(循环)

```text
repeat:
  1. 读 state.json,取 remainingDifferences 头部
  2. 重新诊断根因(必要时查 DOM dump 与 computed styles,不猜)
  3. 实现单假设 → 验证 → 更新 state
  4. 连续 3 轮无进展(ΔS < +0.005)→ 暂停,重新做 Phase 4 诊断,不许盲改
  5. 达标(§2 完成条件)→ 输出完成报告
```

### 终止条件

1. 总相似度 S ≥ 阈值(默认 0.96)且无未决 P0/P1;或
2. 剩余差异全部归因于不可控因素(字体未授权、素材未提供、浏览器渲染差异),输出归因表;或
3. 迭代上限(默认 30 轮)耗尽,输出诚实报告。

---

## 5. State / Memory Design

### 5.1 UI Reconstruction State(schema)

```json
{
  "$schema": "ui-reconstruction-state/1",
  "project": { "path": "", "framework": "", "devCommand": "", "url": "" },
  "reference": {
    "source": "screenshot|dsl|url",
    "files": [],
    "viewports": [{ "name": "desktop", "width": 1440, "height": 900 }],
    "states": ["default", "hover", "active", "disabled", "empty", "loading"],
    "blueprintPath": ".ui-reverse/blueprint.json"
  },
  "viewport": "desktop-1440x900",
  "state": "default",
  "iteration": 12,
  "scores": {
    "current": { "total": 0.93, "struct": 0.95, "geom": 0.90, "pixel": 0.91, "type": 0.94, "color": 0.96 },
    "previous": { "total": 0.92 },
    "delta": 0.01,
    "history": [ { "iteration": 1, "total": 0.61 }, "...最近 50 轮" ]
  },
  "resolvedDifferences": [
    { "iteration": 5, "path": "header", "prop": "height", "expected": 80, "actual": 80 }
  ],
  "remainingDifferences": [
    { "path": "main > .card-grid", "prop": "gap", "expected": 24, "actual": 16, "priority": "P1" }
  ],
  "knownConstraints": [
    { "type": "font-missing", "detail": "参考字体 'DIN Pro' 未授权,已用 'Inter' 替换并记录" }
  ],
  "implementedComponents": [ { "blueprintNode": "card", "component": "src/components/Card.tsx" } ],
  "knownAssets": [ { "name": "logo.svg", "path": "public/logo.svg", "usedFor": "header-logo" } ],
  "typographyProfile": {
    "heading": { "family": "Inter", "size": 28, "weight": 700, "lineHeight": 36, "letterSpacing": 0, "color": "#111" }
  },
  "layoutDecisions": [
    { "blueprintNode": "sticker-close", "decision": "absolute", "reason": "参考为旋转贴纸,旋转节点不可 flex" }
  ],
  "rollbackPoints": [ { "iteration": 7, "git": "a1b2c3d", "note": "gap 修改前" } ],
  "lastChanges": [ { "file": "src/components/Card.tsx", "what": "gap 16→24", "scoreDelta": 0.01 } ],
  "antiHack": { "lastScan": "clean", "violations": [] }
}
```

### 5.2 目录布局(`<项目根>/.ui-reverse/`)

```text
.ui-reverse/
├── env.json                 # Phase 0 产出
├── blueprint.json           # Phase 1 产出(参考侧唯一真相)
├── mapping.md               # Phase 2 产出
├── dom-layout.json          # 最新实现侧布局树
├── state.json               # UI Reconstruction State(每轮更新)
├── history/
│   └── 0012-iteration.json  # 每轮一条:diff-report + changes + verification
├── artifacts/
│   ├── reference-desktop-1440.png
│   ├── baseline-desktop-1440.png
│   ├── current-desktop-1440.png
│   ├── diff-desktop-1440.png        # 热图
│   └── state-hover-*.png            # 伪状态截图
└── report.md                # 最新一轮输出协议报告(§9)
```

### 5.3 更新规则

1. **append-only**:`state.json` 每轮整体重写(小文件),但 `history/` 每轮新增一条,**不覆盖**;`scores.history` 保留最近 50 轮。
2. 每轮开始先 `state_read`;禁止从零重新分析。
3. 修改代码前记 `rollbackPoints`(git commit 或 stash);验证失败后从这里回滚。
4. `remainingDifferences` 永不清零,只把已验证修复的条目移到 `resolvedDifferences`。

---

## 6. Visual Comparison Strategy

### 6.1 分层比较(四层,不是单一分数)

| 层 | 对象 | 方法 | 输出 |
|---|---|---|---|
| 结构层 | 参考布局树 vs 实现布局树 | 树匹配 + 编辑距离(缺失/多余/错位节点) | `compare_layouts` mismatch 列表 |
| 几何层 | 蓝图 regions vs 实现侧区域框 | 匹配节点框的 x/y/w/h/margin 偏差(px) | 逐区域偏差表 |
| 像素层 | 参考截图 vs 实现截图 | 对齐 → SSIM + 像素差比率 + 逐区域热图 | 分层分数 + 热图 PNG |
| 排版层 | typography profile vs computed styles | 逐文本节点:family/size/weight/line-height/letter-spacing/color 偏差 | `compare_typography` 列表 |
| 色彩层 | 参考调色板 vs 实现主色 | 主色提取(量化聚类)+ ΔE(CIEDE2000) | 色差表 |

### 6.2 对齐规则(像素层前置)

- 同视口同 DPR 直比(strict 模式,最终评分只用此模式)。
- 参考截图与实现截图页面内容区不同(如浏览器 chrome 残留):先裁剪内容区(检测页面底色边界),再比。
- 视口不一致时禁止直接比;`compare_screenshots` 拒绝并提示先统一视口。**绝对不允许缩放截图打高分。**

### 6.3 区域划分与加权

- 参考侧 regions 来自蓝图(P0:header/sidebar/main/footer;P1:卡片/表单;P2:图标区)。
- 纯截图参考(无 DSL)时:用布局内核的带状聚类(§12 算法 §3.5)自动切出区域,再映射优先级。
- 加权评分:

```
S = 0.30·S_struct + 0.30·S_geom + 0.20·S_pixel + 0.10·S_type + 0.10·S_color
```

- 区域加权:每个 P0 区域在几何层与像素层的权重 ×2;P0 区域得分 < 0.9 时,总分不可达完成线(防止"整体还行、头部烂掉")。
- 每层 S 归一化到 [0,1],像素层用 `SSIM`,几何层用 `1 − mean(|Δ|/容器参考尺寸)`。

### 6.4 使用纪律

- **分数是导航信号,不是结论**:总分类似不代表可完成;诊断必须看结构化差异与热图。
- 每轮记录分层分数与 ΔS;ΔS ≤ −0.02 触发自纠错。
- 完成判定:总分达标 **且** 无未决 P0/P1 **且** 排版层逐项偏差在容差内(字号/行高 ≤ 1px、字重差 ≤ 1 档、色差 ΔE ≤ 3)。

---

## 7. Self-Correction Strategy

### 7.1 Regression 检测

- 触发:ΔS ≤ −0.02,或任何层分数下降 > 0.05,或新增 P0 差异。
- 检测点:每轮 `score_report` 自动计算并标记。

### 7.2 定位与回滚

```text
1. 读 history/ 最后一条:本轮改了哪些文件(change log 与 git 对应)
2. 若本轮是单假设 → 直接回滚该修改(git checkout 具体文件 / 反向 edit)
3. 若分数持续下降但单轮无感 → 对最近 N 轮变更做二分:从 rollbackPoints 中
   最近的干净点回滚,重新验证
4. 回滚后必须重新截图验证,分数回到回滚前水平才可继续
5. 把该修改标记为 "rejected" 写入 remainingDifferences 的备注,避免重犯
```

### 7.3 停滞检测(防盲目迭代)

- 连续 3 轮 ΔS < +0.005 → 停止修改,回到 Phase 4 重新诊断;若仍无进展,重新审视根因假设(可能是 DOM 结构问题而非 CSS)。
- 同一区域连续 2 次修改都无效 → 怀疑根因分类错误(如以为是 CSS 实际是字体)。

### 7.4 不可控因素白名单(不算 regression,算 knownConstraints)

| 因素 | 处理 |
|---|---|
| 参考字体未授权/不可用 | 用最接近的可用字体替换,记录约束;不计入排版失分 |
| 素材(图片/图标源文件)未提供 | 用占位符,标记 `asset-missing`,禁止用近似图冒充 |
| 浏览器渲染差异(亚像素抗锯齿、滚动条宽度) | 记录并豁免 ±1px |
| 目标框架技术限制(如 canvas 图表库) | 记录,说明可消除性 |

---

## 8. Anti-Hack Strategy

### 8.1 静态检查(`anti_hack_scan`,每轮验证前自动执行)

| 规则 | 阈值 | 严重度 |
|---|---|---|
| absolute/fixed 叶子占比 | > 15%(参考为流式布局时) | blocker |
| 全页 canvas 覆盖 | canvas 面积 > 页面 60% 且 DOM 文本缺失 | blocker |
| 背景截图冒充 | 元素 background-image 与参考截图像素 hash 相似度 > 0.95 | blocker |
| 隐藏真实 DOM | display:none/opacity:0/visibility:hidden 元素占比 > 10% | blocker |
| 图片替代文本 | 关键文本节点为 img 而非 text | blocker |
| 单 breakpoint 硬编码 | 单一 media query 内像素覆盖 > 20 条 | warning |
| 内联样式 / !important | 数量 > 10 | warning |
| 大面积负 margin | 出现 > 3 处 | warning |

### 8.2 运行时检查

- DOM dump 必须包含蓝图的语义节点(按 role 匹配);`display:none` 的蓝图节点视为违规。
- 文本必须是真实文本节点(可选中、可被 accessibility 读到)。
- 多视口抽查:声明支持 responsive 时,至少抽查 2 个视口,禁止只修 1 个视口的截图。

### 8.3 计分惩罚与通过条件

- blocker 违规存在时:`score_report` 输出 `blocked:true`,总分显示为 `-1`,**不得进入完成判定**。
- warning 违规在完成报告中列出,要求说明必要性。

### 8.4 与 layout-infer 的联动

- 改造后的 `page_layout_tree` 输出 `stats.absolute` 占比,直接喂给本扫描器,无需额外 DOM 遍历。
- 参考侧本身是绝对定位设计(如贴纸稿)时,阈值自动放宽:以参考树的 absolute 占比 × 1.5 为上限。

---

## 9. Output Protocol

### 9.1 每轮报告模板(写入 `report.md`,同时输出到对话)

```markdown
## 第 12 轮 Reconstruction Status

- 完成度:布局 96% / 组件 92% / 文字 94% / 色彩 97%
- 总分 S = 0.95(Δ +0.01),结构 0.96 / 几何 0.93 / 像素 0.94 / 排版 0.95 / 色彩 0.97

## Visual Difference(当前最大差异)

- header 高度:期望 80px,实际 64px(P0,几何层,热图区域偏差 22%)

## Root Cause

- CSS 问题:`src/styles/header.css` 中 `.header { height: 64px }`
  未使用设计 token;参考高度来自蓝图 regions.header。非 DOM/字体问题。

## Changes

- `src/styles/header.css`:`height: 64px → 80px`
- (git: a1b2c3d,回滚点已记录)

## Verification

- S: 0.94 → 0.95;header 区域 SSIM: 0.81 → 0.93;热图 header 区域 diff 22% → 5%
- anti_hack_scan: clean

## Remaining(按优先级)

- [P1] main > .card-grid gap: 24 vs 16
- [P2] 图标颜色:参考 #5B8DEF vs 实现 #7FA8F5(ΔE 4.1)
- [P3] footer 底部留白 1px 偏差

## Next Action

- 修 card-grid gap(P1 中影响最大,预计 Δ +0.01~0.02)
```

### 9.2 完成/终止报告模板

```markdown
# UI 还原完成报告

- 最终 S = 0.97,满足完成条件(无未决 P0/P1,排版/色彩在容差内)
- 迭代 18 轮,修改文件 9 个,回滚 1 次

## 已解决差异(摘要)
| 区域 | 属性 | 期望 → 实际 | 轮次 |

## 剩余差异与归因
| 差异 | 归因分类 | 可消除? | 说明 |
| 字体 DIN Pro 未授权 | 素材/授权缺失 | 否(需授权) | 已用 Inter 替换,字形差异 ≤ 1% |
| 按钮内边距 1px 偏差 | 浏览器渲染差异 | 否 | 亚像素抗锯齿所致 |
| 图表库渲染阴影差异 | 技术限制 | 否 | 第三方库不支持该 shadow 参数 |

## 诚实声明
以下差异无法消除:...原因:...是否为浏览器渲染差异/素材差异/技术限制:...
```

---

## 10. Recommended Project Structure

### 10.1 monorepo 新增包(`packages/ui-reverse-agent`)

```text
packages/ui-reverse-agent/
├── package.json                  # name: @3kaiu/dsh-ui-reverse-agent;deps: playwright, layout-infer, plugin-kit
├── cordis.patch.yml              # insert: { id, name, inject: [tools, browser?] }
├── build.mjs                     # 沿用 layout-infer 的 esbuild 打包方式
├── src/
│   ├── index.ts                  # 入口:注册全部工具 + browser service + 启动校验
│   ├── config.ts                 # 阈值/权重/容差常量(§6.2、§8.1 集中于此)
│   ├── agent/
│   │   ├── prompt.ts             # §2 system prompt 模板(占位符注入)
│   │   └── preset.md             # agent preset 文档(拷入 ~/.dsh/.agent-presets/ui-reverse/)
│   ├── perception/
│   │   ├── reference.ts          # reference_ingest:截图/DSL/URL → blueprint.json
│   │   └── browser.ts            # Playwright service:start/viewport/navigate/screenshot/dom_dump/state/console
│   ├── measure/
│   │   ├── dom-to-layout.ts      # ★改造核心:DOM dump → 标准 DSL 树(复用 cleanToStandardDsl 管线)
│   │   ├── compare.ts            # compare_layouts:树匹配 + 编辑距离 + 差异列表
│   │   ├── geometry.ts           # compare_geometry:区域框偏差
│   │   └── typography.ts         # compare_typography:排版档案对比
│   ├── compare/
│   │   ├── align.ts              # 内容区裁剪/对齐
│   │   ├── pixel.ts              # SSIM + 像素差 + 热图(纯 Node 实现或 sharp/ssim 依赖)
│   │   ├── palette.ts            # 主色提取 + CIEDE2000
│   │   └── score.ts              # score_report:加权总分 + ΔS + regression 标记
│   ├── memory/
│   │   └── state.ts              # state_read/state_update + history 追加
│   ├── guard/
│   │   ├── antihack.ts           # anti_hack_scan(§8.1 规则表驱动)
│   │   └── selfcorrect.ts        # 回滚指令生成 + 停滞检测
│   └── services/
│       └── devserver.ts          # dev server 子进程托管(启动/健康检查/停止)
├── test/
│   ├── dom-to-layout.test.mjs    # fixture:真实 DOM dump → 布局树
│   ├── compare.test.mjs
│   ├── score.test.mjs
│   ├── antihack.test.mjs
│   └── browser.test.mjs          # (需 chromium,标记 integration)
└── fixtures/
    ├── dom-dump-*.json           # 真实页面 DOM dump 样例
    └── blueprint-*.json
```

### 10.2 Agent preset(`~/.dsh/.agent-presets/ui-reverse/`)

```text
ui-reverse/
├── agent.yml        # 名称/描述/工具绑定(全部 §3.1 工具 + 宿主 repo 工具)
├── prompt.md        # §2 system prompt(启动时注入环境参数)
└── config.yml       # 阈值覆盖(COMPLETE_THRESHOLD 等,按任务可调)
```

### 10.3 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 测量底座 | `page_layout_tree` + `compare_layouts` + `compare_screenshots` + `score_report` 可用 | 用 fixtures 跑通"参考 DSL ↔ 模拟 DOM"闭环,分数可复现 |
| M2 感知与守卫 | `reference_ingest`、`browser_*`、`anti_hack_scan` | 真实项目启动、截图、DOM dump、扫描全通 |
| M3 端到端单页 | 对一个简单静态页跑完整 Phase 0-7 | 达到 0.95+ 或输出诚实归因报告 |
| M4 多状态多视口 | 伪状态触发 + 双视口对比 | hover/active/disabled 各状态截图对比通过 |

### 10.4 与现有包的关系

- `layout-infer` 的改造(§11)优先,因为 `dom-to-layout` 依赖其内核;改造放 layout-infer 包内,ui-reverse-agent 依赖它。
- `dsh-console` 可在 M3 后加"还原任务看板"(进度/热图/报告),非必需。

---

## 11. layout-infer 改造方案

### 11.1 现状与缺口

现状(§12 文档):4 个工具,输入是 **MasterGo 拍平稿/DSL**,算法以"堆叠设计稿容器"为标准格局,输出技术中立结构。**设计假设:输入有确定边界、有原生信号(类型/命名/可选 flexContainerInfo)、是静态单画布。**

做 UI 1:1 还原 Agent 需要补的缺口:

| 缺口 | 说明 | 改造 |
|---|---|---|
| 输入源单一 | 只吃 MasterGo DSL/拍平稿 | 新增 DOM dump 输入管线,`clean_layout`/`classify_design` 增加 `source` 参数 |
| 无"实现侧"概念 | 只分析参考稿 | 新增 `page_layout_tree`:DOM dump → 与 annotate_layout 同构的标注树 |
| 无对比能力 | 只输出单侧结构 | 新增 `compare_layouts` / `compare_geometry`:参考树 vs 实现树 |
| 信号分级不适配 DOM | 原生 flexContainerInfo 优先于几何反推;DOM 侧反而应 **computed style 直读优先** | dom-to-layout 走独立信号分级:computed flexDirection 直读 > 几何反推 |
| 容差写死 | TOL=2px 常量 | `inferLayout` 参数化 `tolerance`(默认 2,严格模式 1) |
| 无多状态/多视口 | 单画布 | 工具层由 `reference_ingest` 编排多份输入,内核不变 |

### 11.2 内核改造(`packages/shared/src/layout-core.ts`)

1. `inferLayout({ container, children, tolerance?, absolutesWhitelist? })`:
   - `tolerance` 传入对齐判定、回写验证(§12 §2.1/§2.6);
   - `absolutesWhitelist` 供守卫层传入"参考本身是绝对定位"的白名单 id,白名单内不进绝对占比统计。
2. 新增 `layoutFromDslLike(tree)` 归一化入口:接受"DOM dump 转换后的中间结构"与"MasterGo DSL"两种形态,内部统一走 `reconstructHierarchy`(§12 §3)。
3. 保持 2px 回写验证不变式;DOM 侧验证用 computed rect 而非相对坐标。

### 11.3 新增 `dom-to-layout`(改造核心,放 layout-infer 包)

```text
browser_dom_dump(含 rect + computed) 
  → 1. 过滤:display:none / 零尺寸 / 纯装饰(::before 等伪元素直读 computed)
  → 2. 归一化:每可见元素 → 节点 {x,y,w,h, role, text, computed 子集}
       (computed 子集: display/flexDirection/position/padding/gap/
        font*/color/backgroundColor/borderRadius/opacity/transform)
  → 3. 容器判定:有子元素且(display:flex/grid/block 包裹) → 容器
       —— 与拍平稿不同:DOM 自带层级,不需要"容器吸收/带状聚类"重建层级,
       只需按 DOM 树聚合 + 对每个容器走 inferLayout(几何)或直读(computed)
  → 4. 信号分级(与 MasterGo 相反):computed flexDirection/gap/padding
       直读(conf 1.0) > 几何反推(conf 0.7-0.95) > 降级 absolute(conf 0.4)
  → 5. 输出:与 annotate_layout 同构的标注树 + stats
```

关键点:**DOM 侧不再做层级重建**(DOM 树就是层级),只做"计算属性直读 + 几何验证"——大幅降低误判率,也天然满足 anti-hack 的"真实 DOM"要求。

### 11.4 新增对比工具(`compare_layouts`)

- 匹配:参考树与实现树先按语义名/role 匹配,未匹配按 bbox 最近邻回填;
- 差异:每对匹配节点逐属性比较(flexDirection/gap/padding/alignItems/尺寸/位置),输出 `{path, prop, expected, actual, delta, priority}`;
- 优先级推断:区域级 P 标签(蓝图 regions)继承到子树;缺 P 标签按差异幅度映射(P0:容器结构/页面尺寸;P1:尺寸间距排版;P2:颜色圆角)。
- 树编辑距离输出 missing/extra 节点集。

### 11.5 `classify_design` 扩展

- `source: "dsl" | "dom"`:DOM 模式跳过原生信号直读,改用 computed style 直读 + 几何反推;
- 资产清单在 DOM 模式下输出 `images`(img/src)、`fonts`(font-family 使用列表,供字体缺失检测)、`icons`(svg/img 短路径)。

---

## 12. 需要你提供的输入(按优先级)

1. **layout-infer 已知边界确认**:§12 文档 §9 的边界清单是否已过时;`inferLayout` 对"DOM 几何反推"的适配预期(尤其 gap 众数判定在真实页面间距噪声下的表现)。
2. **真实目标项目样例 1 个**:用于 M3 端到端验收(建议一个带 header/sidebar/card 列表的中型页面 + 对应参考截图)。
3. **浏览器栈决策**:是否允许 ui-reverse-agent 内置 Playwright + 下载 chromium(~170MB);还是复用环境已有浏览器。dev server 由 Agent 托管还是外部已起。
4. **MasterGo DSL 全量样例**:若参考输入经常是 DSL,需要 2-3 份真实完整 DSL(含 styles 表)做 `reference_ingest` 的 fixture。
5. **多状态参考样例**:至少 1 组 hover/active 状态截图(或可交互参考 URL),用于 M4 验收。

---

## 附:A 与 B 两条管线的分工

| | A: 参考侧(design → structure) | B: 实现侧(dom → structure) |
|---|---|---|
| 输入 | 截图 / MasterGo DSL / 参考 URL | browser_dom_dump |
| 管线 | clean_layout / annotate_layout / classify_design | dom-to-layout(§11.3) |
| 输出 | blueprint.json | dom-layout.json |
| 合并 | — | compare_layouts(参考树 vs 实现树) |
| 容差 | TOL=2px(回写验证) | 同左 + computed 直读 |
