// TS 版构建（最终产物仍为压缩 dist）
// @3kaiu/dsh-llm-opencode-zen 构建
// node half(dist/index.js,esm 普通打包)+ browser half(dist/client.js,
// closure-factory bundle:window.__ModuleLoader__.load({id, factory}),所有
// 平台依赖 external,由 loader module table 在运行时提供)。
// 注意:node half 禁止 minify —— Typert SRC 描述符从方法源码解析参数名
// (methodParameterNames 用 Function#toString),参数名被压缩后 RPC 会失配;
// @deepseek-ai/dsh-typert-protocol 必须 external(host 提供,避免 cordis/标记双实例)。
import { build } from "esbuild";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";

const ID = "@3kaiu/dsh-llm-opencode-zen";

// loader module table 的平台 seed + 官方 client 包(web 前端预装,运行时 require 走表)
const PLATFORM_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-connection/client",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-remotes/client",
];

await build({
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: false,
  legalComments: "none",
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  // DSH 外部清单单一来源(scripts/esbuild-common.mjs)防漂移; dsh-tools 本包未引用, external 无害
  external: ["@deepseek-ai/dsh-typert-protocol", ...DSH_EXTERNALS],
});
console.log("built dist/index.js");

// browser half(先打裸 CJS,再包 closure factory)
await build({
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  jsx: "automatic",
  entryPoints: ["src/client.tsx"],
  outfile: "dist/client.raw.js",
  external: PLATFORM_EXTERNALS,
});
const body = readFileSync("dist/client.raw.js", "utf8");
const wrapped =
  "window.__ModuleLoader__.load({\n" +
  "\tid: \"" + ID + "\",\n" +
  "\tfactory: (require) => {\n" +
  "\t\tvar module = { exports: {} };\n" +
  "\t\tvar exports = module.exports;\n" +
  body + "\n" +
  "\t\treturn module.exports;\n" +
  "\t}\n" +
  "});\n";
writeFileSync("dist/client.js", wrapped);
rmSync("dist/client.raw.js", { force: true });
console.log("built dist/client.js (" + wrapped.length + " bytes)");
