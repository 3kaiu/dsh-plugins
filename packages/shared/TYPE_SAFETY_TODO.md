# Shared Package - Type Safety

## Status: strict build enabled ✅ (2026-09-04)

- 全仓门禁(`npx tsc --noEmit`, strict 根配置)0 错误。
- 全部 5 个包的 `tsconfig.build.json` 已由 `strict:false` 翻转为 `strict:true`
  (测量显示翻转零成本 —— 根门禁早已按 strict 覆盖所有 src)。
- `tsconfig.build.json.strict` 副本已删除(其使命即 strict 主配置, 不再需要)。

历史 ~529-error 战役记录见 `/docs/TYPE-FIX-PROGRESS.md`(commit c7e7b5a)。

## Remaining debt (precision, not strictness)

- 战役期批量标注大多是 `any` / `as any` 占位符, 非精确类型 —— strict 门禁
  对它们不报错, 精度债仍在。
- 渐进方向: 核心数据结构(`layout-core` InferResult、`dsl-clean` node
  shapes)与公共 API 面优先 → 逐文件替换占位符。

Declaration emit for consumers keeps working (strict, emitDeclarationOnly).
