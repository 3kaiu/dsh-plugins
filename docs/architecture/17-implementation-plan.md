# UI Restore Agent — 技术方案 v4（执行级修订）

> 相对 v3 的关键变更：
> 1. 从 A–E 五 Milestone 收敛为 **3 阶段**：Understand → Generate -> Converge（Vision 降为 3.5 fallback，Semantic 降为 enhancement）。
> 2. 新增 **8 个 P0 基础契约/组件**：Truth Spike / Generation Contract / Asset Contract / DOM Map / Error Taxonomy / Patch Contract / Patch Validator / Convergence Score。
> 3. Project Analyzer 拆 **Facts + Resolver**，置信度排序，未知=unknown（不自作主张 css-modules）。
> 4. LLM Patch 从「自由改码」降级为 **受限修改器 + Patch Validator + Patch Policy**。
> 5. Truth 前置 Spike；diff 验收改为 **global + region + geometry 组合**；迭代改为 **单调收敛**（非固定 5 次）。
> 6. 字体提为 P0；OSS 暂停扩研。

---

## 0. 范围裁定（延续 v3）

**V1 = 隔离新组件**：生成独立组件/页面文件 + 最小渲染入口，不 merge 进既有架构（merge 推 V2）。理由：隔离变量，区分「UI 还原失败」与「项目集成失败」。

**核心抽象升级**：真正的生成路径不是 `Blueprint → React emitter`，而是：

```
Design IR + Target Profile + Implementation Policy = Generation Plan
   ↓
Target Adapter (Strategy IR → serializer)
```

`layout.role`（设计语义）≠ 目标实现（flex/grid/absolute/Row/HStack），中间必须有「布局策略」一层决策。

---

## 1. 总体架构（方向确认，9/10）

```
MasterGo DSL ──► Blueprint(UI IR)
                    +
              Project Analyzer(Facts) ──► Resolver ──► Target Profile
                    +
              Implementation Policy
                    =
              Generation Plan
                    ↓
              Target Adapter (Strategy IR → serializer)
                    ↓
              Generated Code (+ Source/DOM Map)
                    ↓
              Render ──► Verify(四闸) ──► Error Classification
                    ↓                        ↓
              Region→Node→Source 定位   Repair Strategy
                    ↓                        ↓
              Patch Request ──► LLM(受限) ──► Patch
                    ↓
              Patch Validator ──► Render ──► Score ──► Accept/Reject(best/regress)
```

---

## 2. 集成模式与 OSS（沿用 v3，V1 暂停扩研）

| 工具 | 模式 | 接入点 |
|------|------|--------|
| MasterGo MCP / DSL 类型 / Yoga / Playwright / pixelmatch / llm-opencode-zen / renderGeometrySnapshot | **直接使用** | Extract / Layout Calc / Render / Pixel Diff / LLM / 自动 truth |
| FigmaToCode / Grida | **吸纳** | 发射器模板参考，不引代码 |
| Design2Code | **融合(概念)** | merge-engine / detector 思路；探测规则参考 |
| aesthetic-function | **融合(概念对齐)** | reconciliation 已被 verify 四闸+记账实装 |
| screenshot-to-code | **吸纳+参考** | 循环范式 / benchmark |
| Layout (uselayout) | **吸纳** | Blueprint→MCP context 形状（ enhancement 阶段） |
| Taffy | 暂不用 | 已有 Yoga |

> **V1 暂停任何新 OSS 调研**。现有已足够，先把东西串起来。

---

## 3. 三阶段总览

| 阶段 | 目标 | 必须产出的决策点 |
|------|------|------------------|
| **Phase 1 Understand** | 把设计与项目都「理解」成可执行的生成计划 | Truth 获取路径 / Target Profile / Generation Contract / Asset Contract / Error Taxonomy |
| **Phase 2 Generate** | 把计划变成代码 + 可定位映射 | React Adapter / Asset Resolver / DOM Map / Source Map |
| **Phase 3 Converge** | 渲染→验证→定位→受限修改→评分→收敛 | Region→Node→Source 定位 / Patch Contract / Patch Validator / Convergence Score |
| **Phase 3.5 Vision** | 仅作 fallback 诊断 | 确定性验证报「有问题但说不清原因」时才启 |
| **Enhancement Semantic** | 代码质量增强（非闭环必需） | component detection / LLM naming / MCP context |

---

## 4. Phase 1 — Understand

### P0-1 Truth Spike（**最先做，S 级**）
- **目的**：验证「MasterGo container DSL link → 对应 viewport 完整 PNG」能否稳定获取（尺寸/DPR/背景/字体/整页）。
- **做法**：Spike 不写功能，只验证获取链路。若 PNG 不可靠，则闭环的 `diffRatio` 失据 → 必须先用 `renderGeometrySnapshot` 兜底并调整验收。
- **出口**：明确 truth 来源与可靠性等级（PNG 完整 / PNG 残缺 / 仅几何快照）。

### Project Analyzer：Facts + Resolver（修正 v3 的「100% 探测」与 css-modules 默认）
- **Analyzer（观察事实，带置信度）**：扫 `package.json`/`pubspec`/`app.json`+`.wxml`/`*.swift`/`vite`/`tsconfig`，输出**置信度排序的候选列表**，不输出单一断言：
  ```ts
  {
    framework: [{name:'react', confidence:0.99}],
    language:  [{name:'typescript', confidence:1}],
    styling:   [{name:'tailwind', confidence:0.96}, {name:'styled-components', confidence:0.31}],
    componentLibraries: [{name:'antd', confidence:0.97}]
  }
  ```
- **Resolver（做决策）**：消费 Facts → 产出唯一 `Target Profile`。Analyzer 只回答「观察到什么」，Resolver 才回答「因此选什么」。**LLM 参与项目理解时也不污染 Facts**。
- **默认未知**：未探测到样式方案时 = `unknown` / `plain-css`，**绝不默认 css-modules**（避免偷偷改技术栈）。
- 文件：`src/target/{detect.ts( facts ), resolve.ts( resolver ), types.ts, profile.ts}`。

### P0-2 Generation Contract（**核心缺层**）
- 定义「每个 Blueprint 能力在目标栈怎么实现」的决策，而非能力清单：
  ```ts
  type GenerationContract = {
    nodeId: string
    layout:    { strategy: 'flex' | 'absolute' | 'grid' | 'flow' }
    paint:     { strategy: 'css' | 'asset' | 'svg' }
    typography:{ strategy: 'native' | 'rich-text' }
    component: { strategy: 'native' | 'library'; name?: string }
    asset?:    { source: string }
  }
  ```
- `layout.role`（设计语义）→ `layout strategy` → 目标实现（React flex / Flutter Row / SwiftUI HStack），**不写死** `row→display:flex` 语义等价。
- 文件：`src/target/contract.ts`（`blueprint + targetProfile → contract[]`）。

### P0-3 Asset Contract（**S 级，需深挖**）
- 定义 image/svg/gradient/crop/transform 的完整生命周期：**identity / extraction / storage / path / format / transformation / crop / scaling / dedup / reference**。
- 图片：`image + crop=cover + position` → `background-image/size/position` 必须一致。
- SVG：不仅 `svgKey→file.svg`，还需处理 viewBox/width/height/fill/stroke/scale/clip/transform，否则 diff 直接炸。
- 文件：`src/target/asset-resolver.ts`（含 B0 的 `mcp_extractSvg` 回填，未解析禁止近似替代）。

### 字体（提为 P0）
- `font-family/weight/size/line-height/letter-spacing/loading/fallback` 任一不同 → 文字宽度→换行→高度→父高→整页连锁 diff。字体不可用时**不能简单判为 CSS bug**。
- 文件：`src/target/contract.ts` typography 段 + `src/ir/text-metrics.ts` 已有实测宽度复用。

### P0-5 Error Taxonomy（**S 级，喂修复**）
- 标准化错误分类， Repair 按类选策略：
  ```
  LAYOUT(position/size/gap/padding/alignment)
  PAINT(color/gradient/opacity/shadow/border)
  TYPOGRAPHY(font/size/weight/line-height/wrap)
  ASSET(missing/crop/scale/svg)
  STRUCTURE(missing/extra/wrong-hierarchy)
  ```
- 例如 `gap mismatch→改 gap`；`position mismatch→查父布局`；`asset mismatch→回 Asset Resolver，禁止 LLM 乱改 CSS`。

---

## 5. Phase 2 — Generate

### React Adapter（V1 唯一验证载体，非架构限制）
- 流程：`Blueprint + Generation Contract → Strategy IR → serializer → 代码`。
- **先生成统一 Style IR**（`{display,width,height,padding,background,borderRadius,...}`），再序列化为目标样式；**V1 只做一种默认 CSS serializer**，Tailwind/styled 留后续（避免 layout×text×fill×border×shadow ×3 组合爆炸）。
- `emit/react.ts` 递归遍历 `tree`，按 `contract.layout.strategy` 输出；绝对/flex 跟随 contract，不跟随裸 `layout.role`。
- **保真清单（V1 必须正确处理）**：`absolute/stack→position:absolute`（安全路径）、`clip/clipShape/contentClipped→overflow:hidden+精确尺寸`（最高风险①）、`fill.gradient→linear-gradient`、`fill.image+crop→cover 映射`、`effects→box-shadow`、`borderRadius` 数组→四角、`svgKey`（依赖 Asset Resolver，最高风险②）、`textRuns/softWrap/maxLines`、`opacity/rotation`。

### Asset Resolver（P0-3 落地）
- 实现 extraction/storage/path/format/transform/crop/scale/dedup/reference；`generate` 前置回填 `assets.json`。

### P0-4 DOM ↔ Blueprint Map（**比 v3 Source Map 更强**）
- 生成代码带 `data-restore-node="<nodeId>"`，并产出 `.restore-map.json`：
  ```json
  { "nodeId":"123", "file":"Button.tsx", "component":"Button",
    "selector":".button_abc", "line":23, "attributes": {"className":"button_abc"} }
  ```
- 链路：`Pixel Region → DOM region([data-restore-node]) → Blueprint node → restore-map → 源文件`。比单纯 `region→nodeId` 靠谱得多，且**成本极低**，进 V1。

### 接口
- `restore.mjs profile <dir>` / `restore.mjs generate <bp> --project <dir> --profile <p.json>`。

---

## 6. Phase 3 — Converge

### Render + Verify（truth 优先级 + 组合验收）
- **truth 优先级**：主=设计导出 PNG（完整保真）；兜底=`renderGeometrySnapshot`（仅几何/色块级）。
- **验收 = 组合 contract（修正「diffRatio<2% 唯一标准」）**：
  ```
  PASS = globalDiff < threshold
       AND criticalRegions < threshold
       AND geometry gates PASS
  ```
  避免「整体 <2% 但核心按钮错位 20px」或「背景渐变微差 3% 但组件全对」的误判。

### P0 定位：Region → Node → Source
- `verify/regions` 的 region → 关联 blueprint nodeIds → 查 DOM Map → 取受影响文件/行 → **仅**把这些 + 修正指令 + 该节点 blueprint 子树喂 LLM。

### LLM Patch = 受限修改器（**最重要改动**）
- **Patch Request**（Verifier 产出，非自由改码）：
  ```json
  { "affectedNodes":["button-12"],
    "violations":["x +4px","height -2px"],
    "allowedFiles":["Button.tsx"], "allowedNodes":["button-12"],
    "constraints":["do not change parent layout","do not add dependency"] }
  ```
- **Patch Policy**（优先级 + 禁止项）：
  ```
  第一优先：调整已有属性
  第二优先：调整父布局
  第三优先：调整节点布局
  禁止：修改无关节点 / 引入新依赖 / 改变架构 / 大范围重写文件
  ```
- **P0-7 Patch Validator**：校验 文件越界？节点越界？依赖增加？DOM 大面积改变？修改量异常？任一 → 拒收，回滚。

### P0-8 Convergence Score（**替代固定 5 次**）
- `score = globalDiff + regionDiff + geometryPenalty + changedAreaPenalty + contractViolationPenalty`。
- 修复 A（global 1.5%/geometry 0/改小面积）> 修复 B（global 1.3%/geometry 坏/改大面积）。
- **停止条件**：单调收敛（每轮 score 不劣化即通过 best/regress）；指标建议 `P50≤3, P90≤5, P95≤8` 或「验证能单调收敛」优先于「5 次必收敛」。

### 文件
- `src/adapters/loop.ts`（编排）、`src/verify/{gate,vision,contract}.ts`、`src/target/patch.ts`（Patch Request/Validator）。

---

## 7. Phase 3.5 — Vision（仅 fallback 诊断）
- 仅当确定性验证「这里有问题」但**无法判断为什么**时启动：`region 成对裁图 → vision → 语义诊断` 回灌 C。
- **不是核心验证层**，是兜底诊断工具。V1 后可做。

---

## 8. Enhancement — Semantic（最后做）
- component detection / LLM naming / MCP design-context 属于**代码质量增强**，非闭环必需。
- 否则项目会从「UI Restore Agent」滑向「AI Frontend Code Generator」，越来越大。
- 文件：`src/classify.ts`（扩 `archetype/role/intent`，低置信才 LLM）。

---

## 9. 最小执行顺序（必须 / 可并行 / 暂缓）

```
① Truth Spike ......................... [必须]
② Project Analyzer(Facts+Resolver) .... [必须]
③ Generation Contract ................. [必须]
④ React Adapter(单 CSS serializer) ..... [必须]
⑤ Asset Resolver ..................... [必须]
⑥ DOM/Source Map ..................... [必须]
⑦ Render + Verify(组合验收) .......... [必须]
⑧ Region→Node→Source 定位 ........... [必须]
⑨ Patch Contract ..................... [必须]
⑩ LLM Repair(受限) .................. [必须]
⑪ Patch Validator .................... [必须]
⑫ Best/Regress/Convergence Score ..... [必须]
   ───────────── V1 成立 ─────────────
⑬ Vision(3.5 fallback) ............... [可并行/稍后]
⑭ Vue / ⑮ Flutter / ⑯ 小程序 ......... [暂缓]
⑰ Tailwind/styled serializers ........ [暂缓]
⑱ Component Library Mapping .......... [暂缓]
⑲ Semantic/Intent .................... [暂缓]
⑳ Merge Existing Project ............. [暂缓]
```

**S 级深挖**：Truth Acquisition、Generation Contract、Region→Node→Source 定位、Patch Contract、Convergence Score。
**A 级**：Asset Resolver、Typography、DOM/Source Map、Error Taxonomy、Analyzer Resolver。
**B 级/暂缓**：Vision、Component Detection、Semantic Naming、MCP context、多框架扩展、V1 Merge、更多 OSS。

---

## 10. 任务拆解（执行级）

| ID | 阶段 | 任务 | 文件 | 验收 |
|----|------|------|------|------|
| P0-1 | U | Truth Spike | `scripts/truth-spike.mjs` | 明确 PNG 获取可靠性等级 |
| A-F | U | Analyzer Facts(置信度列表) | `src/target/detect.ts` | 多栈样例 Facts 正确 |
| A-R | U | Resolver→Target Profile | `src/target/resolve.ts` | 未知=unknown，不默认 css-modules |
| P0-2 | U | Generation Contract | `src/target/contract.ts` | role→strategy→impl 决策可单测 |
| P0-3 | U/G | Asset Contract+Resolver | `src/target/asset-resolver.ts` | image/svg/crop/transform 生命周期闭环 |
| TYPO | U | 字体策略 | `contract.ts`+`text-metrics.ts` | 字体缺失不误判 CSS |
| P0-5 | U | Error Taxonomy | `src/verify/errors.ts` | 5 类→repair 策略映射 |
| ④ | G | React Adapter(单 CSS) | `src/target/emit/react.ts` | 递归 tree→JSX；保真清单全过 |
| P0-4 | G | DOM Map + restore-map | `emit/` + `data-restore-node` | region→node→file 链路通 |
| ⑦ | C | Render+Verify 组合验收 | `src/verify/gate.ts` | global+region+geometry 组合 PASS |
| ⑧ | C | 定位 | `src/adapters/loop.ts` | region→DOM→node→file 定位 |
| ⑨ | C | Patch Contract | `src/target/patch.ts` | Patch Request/Patch Policy 定义 |
| ⑩ | C | LLM Repair(受限) | `src/adapters/loop.ts` | 仅改 allowedFiles/Nodes |
| ⑪ | C | Patch Validator | `src/target/patch.ts` | 越界/依赖/DOM 异常拒收 |
| P0-8 | C | Convergence Score | `src/verify/score.ts` | 单调收敛，best/regress 按 score |

---

## 11. 验收指标重设计
- **组合 contract**：`globalDiff<阈值 AND criticalRegions<阈值 AND geometry gates PASS`。
- **收敛**：单调收敛优先；参考 `P50≤3 / P90≤5 / P95≤8`。
- **反假阴性**：注入偏差必检出（现有 `run-benchmarks.mjs` 坏例门禁）。

## 12. vendor / 明确不做
- 不 vendor 任何发射器代码；仅未来确需引 OSS 时才放 `vendor/` 并保留 LICENSE+provenance。
- **明确不做（V1）**：merge 进既有项目、更多 OSS 调研、多框架扩展、Tailwind/styled serializer、Component Detection、Semantic Naming、Vision 核心层。
- **直接使用（已有）**：MasterGo MCP / Playwright / Yoga / pixelmatch / llm-opencode-zen / renderGeometrySnapshot。
