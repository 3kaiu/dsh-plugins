# Workflow 参考 — Ralph 闭环与手动等价

> 本文件供 LLM 在无 `workflowEngine` 时手动复刻 `preset/ui-reverse/workflow.yml` 的语义。

## 闭环概览

```
Phase0 browser_start → Phase1 reference_ingest → Phase2 仓库映射 → Phase3 baseline（screenshot+dom_dump+page_layout_tree）
→ Phase4 compare_geometry/screenshots/typography/palette + score_report
→ Ralph loop（max 30）：
    state_read 取 remainingDifferences[0]
  → fanout_evaluate（3 候选，isConcurrencySafe 并行）
  → edit 单文件（仅 best.value）
  → anti_hack_scan → browser_screenshot/dom_dump → compare_* → score_report → state_update
  → 自纠错：Δ≤-0.02 或 blocked 则回滚
→ 直到 S≥0.96 且无 P0/P1
```

## 何时用 workflow.yml

- 宿主已安装 `dsh-workflow-engine + tool-workflow/tool-ralph`：直接 `dsh workflow run --preset ui-reverse --workflow preset/ui-reverse/workflow.yml`
- 未安装时：LLM 按上图手动串行，注意扇出评估可并发（`fanout_evaluate` 的 3 候选已声明 `isConcurrencySafe:true`，宿主并行调度器会自动并发）

## 与 state 的联动

- 每轮结束必 `state_update`（已自动同步 `goals.json/todo.json/todo.md`）
- `loop.until` 的退出条件与 `score_report.complete` 一致

## 降级

无 workflow 引擎时，忽略 `workflow.yml` 的 `type: ralph`，用 `while` + `state_read` 手动循环即可，效果等价。
