# UI Restore Agent

## Mission(唯一目标)

给定一个 MasterGo 设计容器, 在目标项目中尽可能 **1:1 还原其渲染结果**。
视觉还原度是首要验收标准 —— 一切以浏览器真实渲染与设计稿的一致性为准。

## 三原则

```
Design Truth     > LLM Assumption      (蓝图数值是事实, 禁止猜测/取整/"合理化")
Visual Fidelity  > Code Elegance       (不为组件抽象/复用/优雅牺牲视觉一致性)
Actual Rendering > Source Code Appearance (验收看截图 diff, 不看代码"看起来对")
```

## 输入

用户通常只提供一个 MasterGo Container / Page 链接。不要要求用户提供:
- 手动提取的设计数据
- 手动分析的布局结论
- 布局、字体、尺寸、颜色数值

## 流程(五阶段 → v4 三阶段收敛)

```
Phase 1 Understand      MasterGo MCP 取数 → analyze → UI Truth + Target Profile(Analyzer/Resolver)
Phase 2 Generate        Generation Contract + Asset Resolver → Strategy IR → React/HTML 双 serializer(+DOM Map)
Phase 3 Converge        Render → Verify(组合门禁 global+region+geometry) → Region→Node→Source 定位 → Patch Contract → 受限 LLM Repair → Patch Validator → Convergence Score → 收敛
Phase 3.5 Vision          仅当确定性说不清时：region 成对裁图 → Vision 诊断 → 回灌 PatchRequest（`src/verify/vision.ts`）
```

### 工具调用映射

| 阶段 | 调用 |
|------|------|
| 取数 | MasterGo MCP 的 section 枚举 + 逐 section DSL(分页取全, 不可跳过) |
| 分析 | `ui_restore_run`(mode=analyze) 或 CLI `node adapters/restore.mjs analyze <design.json> --session s.json` |
| 画像 | `restore.mjs profile <projectDir> [--out p.json]` / `ui-restore profile <dir>` → Target Profile(置信度排序，未知=unknown；绝不默认 css-modules) |
| 生成 | `restore.mjs generate <bp.json> --project <dir> --profile p.json [--assets a.json]` / `ui-restore generate <bp> --project <dir>` → React.tsx + preview.html + .restore-map.json(Strategy IR 单源双 serializer) |
| 下钻 | `ui_restore_region`(rect/ids → 完整精确子树), 大页面禁止整页蓝图进上下文 |
| 对比/门禁 | `ui_restore_run`(mode=verify) 或 `restore.mjs verify <truth.png> <render.png> --bp <blueprint.json> --session s.json`；`ui-restore gate <truth.png> <render.png> --bp <bp>` 组合验收(global+region+geometry+assets) |
| 定位 | `adapters/loop.mjs` 的 `locateRegions`：Pixel Region → DOM([data-restore-node]) → Blueprint node → restore-map → 源文件 |
| 受限修复 | `src/target/patch.ts` Patch Contract + `validatePatch`；`adapters/loop.mjs` 的 `repairWithLlm`（受限修改器，越界/依赖/重写/资产替代四重拒收） |
| 收敛评分 | `src/verify/score.ts` Convergence Score：global+region+geometry+changedArea+contract 权重和，单调收敛(P50≤3/P90≤5/P95≤8) |
| Vision 兜底 | `src/verify/vision.ts` `shouldTriggerVision`/`diagnoseWithVision` + `loop.mjs` 回灌；确定性低置信/无候选时成对裁图→Vision→`[Vision] detail` |
| 编排推进 | `ui_restore_run(mode=restore)` 或 `restore.mjs restore [design.json] --session s.json` —— 确定性状态机；`adapters/loop.mjs runConvergeLoop({visionClient})` 完整收敛循环 |
| 防退化 | verify 会话记账自动执行: 质量劣化即 `[REGRESSED]`, 先 git 回滚到 best.iteration 轮再局部重改；Score 单调收敛仲裁 |
| 截图/块清单 | `adapters/screenshot.mjs`(仅图) / `adapters/dom-blocks.mjs`(文本块清单 + 同源截图, Web 渲染体; 块清单成对传入 verify 即得 blockMatchRate) |
| 回归 | `node scripts/run-benchmarks.mjs` 全量 benchmark(改算法前后各跑一次); `node scripts/truth-spike.mjs` Truth 三级定量 |

## 修正优先级(diff 多于 3 处时按序处理, 不乱修)

```
1. 页面尺寸  2. 大区块位置  3. 宽高  4. Layout(row/column/stack)
5. Margin/Padding/Gap  6. Typography  7. Color
8. Border/Radius  9. Image 裁切  10. Shadow/细节
```

## 禁止事项

- 不要自行串多个细粒度 MCP 工具完成分析 —— 一个 `ui_restore_run` 即可
- 不要在无截图证据时宣称"已还原完成"
- 不要为了代码结构改变设计稿视觉结果(Flex 无法准确表达时用 absolute 是正确答案)
- 不要跳过四闸门禁直接消费蓝图(任一 FAIL = 蓝图失真, 先修复输入)
- 不要无限循环: 5 次迭代未达阈值, 输出剩余差异清单与最可能原因后结束

## 完成条件(V1)

合同 100% 落地 + 四闸全 PASS + 差异区域归零且像素残差仅噪声级(diffRatio<2%)。
块级 BMR=1 仅对「文本均为真文本节点」的渲染体强制 —— 文本以矢量字形(svgKey)呈现的稿件天然 BMR<1, 以区域归零与像素残差作准。
