# case-live-course-card — 轮播卡端到端 benchmark(多通道)

来源: MasterGo live-phone 稿 `output/study-live-phone-raw.json` 的课程轮播卡 section(`408:9126`, 327×185 @24,104, 即桌面 Skill P3 实测形态)。

覆盖通道比 case-408-card 更宽: 底部遮罩贴底条、双 chip(62/72×20)、按钮(88×34 inset 底边)、滑动指示器(19.5×6)、文本两行换行、mergedVector 占位。

## 文件

| 文件 | 说明 |
|------|------|
| `restore.html` | 正确实现 —— blueprint 子树逐字段还原(bounds 差值定位) |
| `restore-bad.html` | 注入 2 处已知偏差: chip1 left +8px, 按钮宽 -10px |
| `truth.png` / `render.png` / `session.json` | 运行时产物 |
| `generated/` | 盲还原迭代产物(v15-blind, w4-*)与轮次质量报告 w4-report.md |

## 复现

> design.json 已入库本目录(源稿在 gitignore 的 output/, 复制一份保证回归可复现)。

```bash
cd /Users/edy/dev/dsh-plugins/packages/ui-restore
node packages/ui-restore/dist/restore.js analyze benchmarks/case-live-course-card/design.json --dir /tmp/bm-live
node packages/ui-restore/dist/screenshot.js benchmarks/case-live-course-card/restore.html     benchmarks/case-live-course-card/truth.png --width 375 --height 812
node packages/ui-restore/dist/screenshot.js benchmarks/case-live-course-card/restore-bad.html benchmarks/case-live-course-card/render.png --width 375 --height 812
node packages/ui-restore/dist/restore.js verify benchmarks/case-live-course-card/truth.png benchmarks/case-live-course-card/render.png \
  --bp /tmp/bm-live/design.blueprint.json --session benchmarks/case-live-course-card/session.json
```

## 已验证结论(2026-08)

- 两处偏差分别检出为 #1(minor, chip 区域→关联 408:9132 文本+408:9131 chip 底) 与 #2(noise, 按钮区域→408:9160/408:9162)
- 修正后重跑 → `0 处差异区域`, session `status=completed`(iteration=2)

## W4 盲还属实测(2026-08-27)

见 `generated/w4-report.md`。零上下文子代理按产物包盲还 → 探针 → verify → 修正指令迭代:
3 轮收敛 completed(质量键 [7,0.17,0.15]→[2,0.08,0.06]→[1,0,0], r3 BMR=1, 残差 835px 抗锯齿级)。
附带输入修复: design.json 补 `meta.canvas=375×812`(原文件丢 meta 致画布误推 688 宽);
真值闸 0.5px 为滑动指示器亚像素吸附已知例外。教训: 盲还任务书必须显式限定案例范畴。
