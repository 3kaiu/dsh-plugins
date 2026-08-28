# ui-restore Skill — 视觉还原知识库（由 docs 12/13 提炼）

> 宿主若挂载 `skill-filesystem + tool-skill`，本目录自动进入 `tool-skill` catalog；否则由 preset prompt 直接引用。

## 何时使用
- 收到参考 UI（截图 / MasterGo DSL / URL / 多状态/多视口）且任务是“把目标项目页面改到与参考 1:1”
- 需要判定“该用 flex 还是 absolute”、“间距 24 vs 16 哪个是根因”、“字体缺失如何归因”

## 信号分级（与代码的不变式对齐，TOL=2px 回写验证）

| 信号 | 来源 | 置信度 | 用途 |
|---|---|---|---|
| `computed flexDirection/gap/padding` 直读 | `browser_dom_dump` 的 `computed` | 1.0 | DOM→布局 优先于几何反推 |
| `flexContainerInfo` 原生 | MasterGo DSL | 1.0 | DSL 管线优先 |
| 几何反推（堆叠/带状聚类） | `layout-core:inferLayout` | 0.7-0.95 | 无原生信号时兜底 |
| 降级 absolute | 回写验证失败 >TOL | 0.4 | 仅作最末手段，须写 `layoutDecisions` |

## 布局判定（12 §2-3 的最小集）

1. **容器判定**：有子元素且 `display:flex/grid/block` 包裹 → 容器；DOM 树自带层级，不做带状聚类重建（DSL 才做）。
2. **堆叠吸收**：DSL 容器吸收带内子容器时，子宽度误差 ≤TOL 且不能破坏已确认的 flex 语义。
3. **回写验证**：`inferLayout` 算出的列起点必须与输入 `x` 对齐，否则整容器降级 absolute，不硬凑。

## 差异优先级（13 §4-6）

- **P0** 页面整体/容器结构/Header-Sidebar-Main/页面宽高 — 先修，P0 分 <0.9 则总分不可达阈值
- **P1** 尺寸/间距/排版/Grid-Flex/对齐
- **P2** 颜色/边框/圆角/阴影/图标
- **P3** 1px/opacity 微差

永远取 `remainingDifferences` 头部单假设；连续 3 轮 ΔS<0.005 即停并重回 Phase4 诊断。

## 工作流（13 §4 Phase 0-7）

```
Phase0 环境发现 → Phase1 reference_ingest→blueprint.json → Phase2 仓库映射 → Phase3 baseline截图/DOM
→ Phase4 compare_* 四层差异 → Phase5 单假设 edit → Phase6 anti_hack/screenshot/compare/score → Phase7 循环
```

- 蓝图一次构建全程复用（`.ui-reverse/blueprint.json`）
- 每轮必 `state_read → state_update`（append-only，同步写 `history/` 与 goals/todo）
- 验证顺序：`anti_hack_scan` → `browser_screenshot/dom_dump` → `compare_*` → `score_report`

## 评分（13 §6.3）

`S = 0.30·S_struct + 0.30·S_geom + 0.20·S_pixel + 0.10·S_type + 0.10·S_color`

- 结构/几何失败（缺失/回写超 TOL）即分层 0
- P0 区域在几何/像素层权重×2
- 像素层 `SSIM`，几何层 `1-mean(|Δ|/容器尺寸)`，均归一 0..1

## 反 Hack（13 §8.1）

| 规则 | 阈值 | 严重度 |
|---|---|---|
| absolute/fixed 叶子占比 | >15%（参考流式时） | blocker（score -1）|
| 全页 canvas 覆盖 | >60% 且文本缺失 | blocker |
| 背景截图冒充 | bg-image hash>0.95 | blocker |
| 隐藏 DOM | display:none/opacity:0 >10% | blocker |
| 图片代文本 | 关键文本为 img | blocker |
| 单 breakpoint 硬编码 | 同 media query 像素覆盖>20 | warning |
| 内联/!important | >10 | warning |

参考本身贴纸稿时阈值放宽至 `参考 absolute 占比×1.5`。

## 自纠错（13 §7）

- 触发：ΔS ≤ -0.02 或新增 P0 或某层骤降>0.05
- 动作：读 `history/` 定位本轮 `lastChanges` → 单假设直接回滚该文件；多轮缓降则二分到最近干净 `rollbackPoints`
- 回滚后必重截图验证；rejected 修改备注进 `remainingDifferences` 防重犯
- 白名单（`knownConstraints`）：字体未授权/素材缺失/亚像素±1px/第三方库限制 — 不计 regression

## 产出（13 §5）

```
.ui-reverse/
  env.json / blueprint.json / mapping.md / dom-layout.json / state.json
  history/0012-iteration.json  artifacts/{reference,baseline,current,diff}-*.png
  report.md  goals.json  todo.json
```

每轮 `report.md` 七段：Status / Difference / RootCause / Changes / Verification / Remaining / NextAction

## 变量

`COMPLETE_THRESHOLD=0.96` `REGRESSION_DELTA=-0.02` `NO_PROGRESS=0.005` `STAGNATION_ROUNDS=3` `MAX_ITER=30`；`VIEWPORTS desktop1440x900 dpr2 / tablet768x1024 / mobile375x812`

## 扇出择优（Phase5，isConcurrencySafe）

- `fanout_evaluate` 对同一 `mismatch` 的多候选（默认 期望/±1px 三候选）打补丁→重 `compare_geometry`→`score_report`，返回 `ranked` 按预测总分降序
- 纯测量不改文件，可安全并行；LLM 取 `rank 1` 的 `value` 做 `edit`，避免盲改
- 示例：`gap 期望24 实际16` 三候选 `[24,25,23]` → 预测 24 最优则只改 `gap:24`
- 工作流：见 `preset/ui-reverse/workflow.yml` Ralph 循环与 `references/workflow.md` 手动等价

## 多视口/多状态矩阵与令牌映射

- `viewport_matrix` 展开 `viewports×states` 笛卡尔积（默认 3×4=12），`aggregateMatrixScores` 按 `desktop 1/tablet 0.8/mobile 0.6` 加权聚合，`checkResponsive` 阈 0.85 查断裂
- `token_map` 对 `typographyProfile/palette` 做最近邻：字体 `family/size/weight` 距 <5 复用，颜色 `ΔE≤3` 复用 `comparePalette`，输出 `reuse/near/create` 供 Phase2 决策
- 中立树 `neutral_ingest` 已含精确令牌，映射仅为复用建议，不重推导

## 设计约束与缓存

- `check_design_constraints` 按项目 `spacingScale/colorPalette/typographyScale/borderRadiusScale` 校验候选值（`>2px` 阻断，`>0` 警告），与 `fanout_evaluate` 联动过滤 `ranked`
- `cache`（`hashOf/cacheKey/getCached/setCached`）以 `dslHash+viewport+state+tolerance` 为键，`blueprint/compare` 结果 24h 过期，`invalidateCache(prefix)` 按前缀失效

## 可访问性与大文件

- `check_a11y` 检 `semantic-tag/button 名称/img alt/heading 跳级/对比度<4.5`，与 `anti_hack/verify_neutral` 同属 Phase6 守卫
- `large-file`（`filterAbandonedSections/paginateSections/largeFileDiagnostics`）按画布过滤废弃图层（`x+w<0||x>canvas`），31 sections 分页 10/页，`allAbsolute` 提示 flex 缺失保底

## 容错与 CI

- `recovery_plan` 按 `devServer/browser/network/file` 分类给出 `retry/delay/fallback`（与 `selfcorrect` 视觉回滚互补，`withRetry` 供调用方包裹 `fetch/spawn`）
- `ci_report` 基于 `state` 的 `S≥0.96 无 P0/!blocked` 门禁，`buildCiReport/writeCiArtifacts/ciGate` 产 `report.json/md` 供 CI 归档

## 安全与 Git

- `check_dsl_security` 检 `XSS 文本/URL allowlist/SVG 脚本`（输入侧，与 `anti_hack` 输出侧互补），`sanitizeDsl/sanitizeText` 去控制字符截断 10k
- `git_rollback_point` 读 `HEAD/dirty` 生成 `rollbackPoints` 条目（Phase5 改前锚点，回滚用 `git checkout <sha> -- .`）

## 性能与反馈

- `estimate_cost` 按 `sections×viewports×states` 估 `parse/screenshots/compares` 耗时（`hasBrowser 800ms/shot`），`createMetrics` 采集各阶段 `mark/report` 定位瓶颈
- `capture_feedback` 捕获 `userCorrection` 写 `feedback.json`，`replayFeedback` 回放为 `spacingScale/colorPalette` 约束供下次 `fanout` 优先

## 批判与系统

- `critique_design` 检 `gap 离散>6/主色>8/字体族>3` 等一致性，给出收敛建议（超越像素的设计质量）
- `generate_design_system` 从 `palette/typographyProfile/tree` 抽 `tokens{colors/typography/spacing}+components{按 role 聚类}` 供 `Phase2` 复用

## 反面示例

- 直接 `background:url(reference.png)` — 触发 `backgroundHashSim` blocker
- 估坐标“大概 16px gap” — 禁止，必须 `compare_geometry` 实测
- 一轮改 5 个无关文件 — 禁止，regression 不可定位
