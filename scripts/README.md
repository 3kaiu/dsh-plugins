# scripts — 维护闭环演示脚本

| 脚本 | 用途 | 用法 |
  | --- | --- | --- |
  | demo-maintenance-loop.mjs | 一键演示完整维护闭环链路(incident → 模拟修复 → trace 落盘 → evidence 闸门 → checkpoint → knowledge → replay → benchmark),全部走真实 CLI 代码路径 | `node scripts/demo-maintenance-loop.mjs`(exit 0 = 链路通过) |
  | demo-unattended.mjs | 无人值守维护演示:压缩时间线 00:00 失败 → 01:00 恢复点 → 02:00 修复 → 02:20 evidence 放行 → 02:30 guard 放行 → 02:40 合入,发行门禁通过 | `node scripts/demo-unattended.mjs`(exit 0 = 演示通过) |
  | demo-fake-completion.mjs | 假完成拦截演示:evidence 闸门 4 场景 3 拦 1 放 | 见 11 篇 §9 |
  
两者都不需要外部 LLM key,可重复运行,可进 CI/演示。
