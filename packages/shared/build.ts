// TS 版构建（最终产物仍为压缩 dist）
// @3kaiu/dsh-plugin-kit 构建: esbuild 打包 src/index.ts → dist/index.js(压缩)
import { buildBundle } from "../../scripts/esbuild-common.mjs";
import { execSync } from "node:child_process";

// 1. 生成 JS bundle
await buildBundle("src/index.ts", "dist/index.js");

// 2. 生成类型定义
console.log("生成类型定义...");
execSync("npx tsc -p tsconfig.build.json", { stdio: "inherit" });
console.log("Done");
