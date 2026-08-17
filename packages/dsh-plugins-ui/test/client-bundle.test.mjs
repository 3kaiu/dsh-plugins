// dsh-plugins-ui browser half bundle 结构验证:
// ① closure-factory 形态(load({id, factory})) ② 平台依赖保持 external(require 未内联)
// ③ stub 环境下 materialize 不炸,exports.apply/inject 形状正确。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "client.js");

test("client bundle: closure-factory 形态", () => {
  const code = readFileSync(BUNDLE, "utf8");
  assert.match(code, /window\.__ModuleLoader__\.load\(/);
  assert.match(code, /id: "@3kaiu\/dsh-plugins-ui"/);
  assert.match(code, /factory: \(require\) =>/);
  // 平台依赖必须保留 require(未被打进包;源码全用 createElement,无 jsx-runtime 引用)
  assert.match(code, /require\(["']react["']\)/);
  // 中文文案以 \u 转义保留,包不依赖外部资源
  assert.match(code, /\\u4FDD\\u5B58/); // "保存"
});

test("client bundle: stub 环境可 materialize 且导出 apply/inject", () => {
  const code = readFileSync(BUNDLE, "utf8");
  let handoff = null;
  globalThis.window = { __ModuleLoader__: { load: (h) => { handoff = h; } } };
  (0, eval)(code);
  assert.ok(handoff, "load 应被调用一次");
  assert.equal(handoff.id, "@3kaiu/dsh-plugins-ui");
  // factory(require): 平台依赖 stub 为空对象(顶层仅引用赋值,不解构)
  const stubRequire = () => ({});
  const ret = handoff.factory(stubRequire);
  assert.equal(typeof ret.apply, "function");
  assert.equal(typeof ret.inject, "object");
  assert.ok(Array.isArray(ret.inject));
  assert.ok(ret.inject.includes("slots"), "inject 应含 slots");
  assert.ok(ret.inject.includes("settingsScope"), "inject 应含 settingsScope");
});

test("node half: 空 apply 占位", async () => {
  const mod = await import("../dist/index.js");
  assert.equal(typeof mod.apply, "function");
});
