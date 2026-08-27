// @ui-restore/core 构建: bundle src/index.ts → dist/ (code-splitting 按需加载适配器)
// 热插拔：核心不静态打包适配器，动态 import 时才加载对应 chunk，Flutter 项目不加载 React/Vue
import { build } from "esbuild";
import { BASE } from "../../scripts/esbuild-common.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await build({
  ...BASE,
  entryPoints: [path.join(__dirname, "src/index.ts")],
  outdir: path.join(__dirname, "dist"),
  splitting: true,
  format: "esm",
  chunkNames: "chunks/[name]-[hash]",
});
console.log("built dist/index.js (+ chunks)");
