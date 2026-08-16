# incidents 维护事项注册表

每个事项一个 JSON 文件,字段(最小契约,可加不可删):

| 字段 | 说明 |
| --- | --- |
| id | 唯一编号,格式 INC-YYYYMMDD-NNN |
| title | 一句话标题 |
| severity | LOW / MEDIUM / HIGH / CRITICAL |
| frequency | 出现频次(排序权重 = 严重度权重 × 频次) |
| taxonomy | 错误分类(与 09 篇 error.recorded 对齐) |
| status | open / fixing / fixed / wontfix |
| reproduce.command | 最小复现命令,**退出 0 = 缺陷可复现**(约定) |
| testCommand | 定向测试命令,退出 0 = 通过 |
| traceRef | 相关 trace/事件文件路径 |
| knowledge | 相关工程记忆(文档/知识条目) |

维护循环(06 篇 §5):cron 每日扫描 → 取 top-1 → agent 修复(分支
maintenance/<id>-<n>)→ dsh-maint verify 闸门 → PR → 人工 merge。
修复完成后把 status 改为 fixed 并提交(由人工 merge 时确认)。

本地事件自动建档:scripts/incidents.mjs 扫描 DSH_HOME/state/events/error.jsonl,
按 taxonomy 聚合生成/更新本条目的 JSON,并可开 GitHub issue(label: maintenance)。
