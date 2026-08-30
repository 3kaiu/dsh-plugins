# case-mg6-study-card — benchmark 第三案例(真实 MasterGo 数据, 非学习 app 稿)

来源: `packages/layout-infer/fixtures/mg-pure-sec-6.json`(真实 MasterGo section 导出,
343×132 "去学习"卡)。前两案例同属学习 app 稿件; 本案例引入**不同数据源**的回归多样性:
嵌套蒙版组、双效果引用(effect_326:04346 双层阴影 / effect_103:15006 按钮内阴影)、
内容越界裁剪窗(封面 144x219 视窗 72x88)、悬浮文本层。

## 文件

| 文件 | 说明 |
|------|------|
| `restore.html` | 正确实现 —— 按 blueprint 逐字段(bounds 唯一真值; 徽章/按钮底色取 styles 表真实画板色 #FEF8EB; 按钮 inset 底影 #FF984E; 封面按"资源待导出"占位, 与 case-408 同配方) |
| `restore-bad.html` | 注入 2 处已知偏差: 徽章文字 top 3→9px(geometry), 统计字号 12→10px(typography) |
| `truth.png` / `render.png` / `session.json` | 运行时产物(可再生) |

## 复现

```bash
node scripts/run-benchmarks.mjs --filter mg6-study-card
```

## 已验证结论(2026-08-30)

- 四闸全 PASS(几何 PASS_PIXEL_PERFECT / 真值 PASS_TRUTH_PERFECT)
- 好例收敛: diff 区域 0, **BMR=1**(文本均为真文本节点, 前两案例的 BMR WARN 语义不适用)
- 坏例注入(top+6px/字号-2px)必检出 ✅
- lint WARN canvas-vs-content(封面内容越界)为预期 —— contentClipped 裁剪窗语义, 不阻断
