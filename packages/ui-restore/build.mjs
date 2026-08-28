// @ui-restore/core 构建: bundle src/index.ts → dist/ (code-splitting 按需加载适配器)
// 热插拔：核心不静态打包适配器，动态 import 时才加载对应 chunk，Flutter 项目不加载 React/Vue
import { build } from "esbuild";
import { BASE } from "../../scripts/esbuild-common.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 运行时第三方依赖保持 external(从宿主 node_modules 解析), 不打包进产物
const RUNTIME_EXTERNALS = [
  "opentype.js",
  "pixelmatch",
  "pngjs",
  "yoga-layout",
  "ws",
  "@modelcontextprotocol/sdk",
  "zod",
  // playwright 为可选运行时依赖（screenshot/dom-blocks 探针），不进 bundle
  "playwright",
  "playwright-core",
];
// 多入口：index=核心库；adapters 全部经同一压缩管线出产物（dist/*.js），
// 不再有裸 .mjs 直跑源码的使用方式（2026-08 起，统一按压缩构建产物使用）
await build({
  ...BASE,
  // {in,out} 对：产物统一拍平到 dist/（dist/cli.js 而非 dist/adapters/cli.js）
  entryPoints: [
    { in: "src/index.ts", out: "index" },
    { in: "src/adapters/cli.ts", out: "cli" },
    { in: "src/adapters/mcp-server.ts", out: "mcp-server" },
    { in: "src/adapters/pipeline.ts", out: "pipeline" },
    { in: "src/adapters/restore.ts", out: "restore" },
    { in: "src/adapters/loop.ts", out: "loop" },
    { in: "src/adapters/screenshot.ts", out: "screenshot" },
    { in: "src/adapters/dom-blocks.ts", out: "dom-blocks" },
  ].map((e) => ({ in: path.join(__dirname, e.in), out: e.out })),
  outdir: path.join(__dirname, "dist"),
  splitting: true,
  format: "esm",
  external: RUNTIME_EXTERNALS,
  chunkNames: "chunks/[name]-[hash]",
});
console.log("built dist/index.js + dist/{cli,mcp-server,pipeline,restore,loop,screenshot,dom-blocks}.js (+ chunks)");
