# .dsh/fixtures — 兼容契约资产(Phase 2)

维护闭环的**契约样例**,供测试与后续场景复用(结构必须与真实 incidents/autopilot.yml 一致):

| 文件 | 用途 |
| --- | --- |
| incidents/inc-open.json | open 状态事项样例(含 knowledge 字段) |
| incidents/inc-fixed.json | fixed 状态事项样例(含 fixedAt/mergedRefs) |
| autopilot.yml | budget + permissions 契约样例(loadContract 解析字段对齐) |

使用方式:复制到对应位置(tmp 仓库的 .dsh/incidents/、.dsh/autopilot.yml)后,loadIncidents/loadContract 即可解析。
测试引用:maintenance.test.mjs「knowledge 沉淀 + fixtures 兼容契约」块。
