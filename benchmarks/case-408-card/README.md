# case-408-card — UI Restore 首个端到端 benchmark

来源: MasterGo 408 稿 `output/study-408-8738-raw.json` 的浅色横向卡 section(`408:8797`, 343×112 @16,372)。

## 文件

| 文件 | 说明 |
|------|------|
| `restore.html` | 正确实现 —— 按 blueprint 子树逐字段手写(bounds 唯一真值, stack 差值定位, softWrap=false) |
| `restore-bad.html` | 注入 2 处已知偏差的"LLM 第一版": 标题 top +6px(geometry), 副标题 12→10px(typography) |
| `truth.png` / `render.png` / `session.json` | 运行时产物(可删, 由下列命令再生) |

## 复现闭环(analyze → 实现 → 截图 → verify → fix)

```bash
cd /Users/edy/dev/dsh-plugins/packages/ui-restore
# 1. 分析: 设计稿 → 蓝图 + 四闸
node packages/ui-restore/adapters/restore.mjs analyze ../../output/study-408-8738-raw.json --dir /tmp/bm
# 2. 截图(系统 Chrome headless, 零依赖)
node packages/ui-restore/adapters/screenshot.mjs benchmarks/case-408-card/restore.html     benchmarks/case-408-card/truth.png --width 375 --height 812
node packages/ui-restore/adapters/screenshot.mjs benchmarks/case-408-card/restore-bad.html benchmarks/case-408-card/render.png --width 375 --height 812
# 3. 对比: 应检出差异区域并精准关联标题节点 408:8798
node packages/ui-restore/adapters/restore.mjs verify benchmarks/case-408-card/truth.png benchmarks/case-408-card/render.png \
  --bp /tmp/bm/study-408-8738-raw.blueprint.json --session benchmarks/case-408-card/session.json
# 4. 修正(把 bad 改回正确)后重截图再 verify → diffRatio=0, status=completed
```

## 已验证结论(2026-08)

- 注入 +6px/字号偏差 → verify 检出 1 处 major 区域, 修正指令第一候选即偏差文本节点 `408:8798`(候选评分=相交面积×覆盖率)
- 修正后重跑 → `0 处差异区域`, session `status=completed`
- 截图引擎为系统 Chrome headless, 未引入任何依赖
