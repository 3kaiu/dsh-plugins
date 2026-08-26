# case-live-course-card — 轮播卡端到端 benchmark(多通道)

来源: MasterGo live-phone 稿 `output/study-live-phone-raw.json` 的课程轮播卡 section(`408:9126`, 327×185 @24,104, 即桌面 Skill P3 实测形态)。

覆盖通道比 case-408-card 更宽: 底部遮罩贴底条、双 chip(62/72×20)、按钮(88×34 inset 底边)、滑动指示器(19.5×6)、文本两行换行、mergedVector 占位。

## 文件

| 文件 | 说明 |
|------|------|
| `restore.html` | 正确实现 —— blueprint 子树逐字段还原(bounds 差值定位) |
| `restore-bad.html` | 注入 2 处已知偏差: chip1 left +8px, 按钮宽 -10px |
| `truth.png` / `render.png` / `session.json` | 运行时产物 |

## 复现

```bash
cd packages/ui-restore
node adapters/restore.mjs analyze /Users/edy/dev/dsh-plugins/output/study-live-phone-raw.json --dir /tmp/bm-live
node adapters/screenshot.mjs benchmark/case-live-course-card/restore.html     benchmark/case-live-course-card/truth.png --width 375 --height 812
node adapters/screenshot.mjs benchmark/case-live-course-card/restore-bad.html benchmark/case-live-course-card/render.png --width 375 --height 812
node adapters/restore.mjs verify benchmark/case-live-course-card/truth.png benchmark/case-live-course-card/render.png \
  --bp /tmp/bm-live/study-live-phone-raw.blueprint.json --session benchmark/case-live-course-card/session.json
```

## 已验证结论(2026-08)

- 两处偏差分别检出为 #1(minor, chip 区域→关联 408:9132 文本+408:9131 chip 底) 与 #2(noise, 按钮区域→408:9160/408:9162)
- 修正后重跑 → `0 处差异区域`, session `status=completed`(iteration=2)
