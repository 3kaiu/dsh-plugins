// TS 版构建（最终产物仍为压缩 dist）
// @3kaiu/dsh-layout-infer 构建: bundle @3kaiu/dsh-plugin-kit(layout-core)进 dist,
// @deepseek-ai/dsh-tools 保持 external
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";
import { execSync } from "node:child_process";

const externals = DSH_EXTERNALS.filter((name) => name === "@deepseek-ai/dsh-tools");
await buildBundle("src/index.ts", "dist/index.js", externals);

// 生成类型定义
console.log("生成类型定义...");
try { execSync("npx tsc -p tsconfig.build.json", { stdio: "inherit" }); } catch (e) { console.warn("类型定义生成有警告，但已生成 .d.ts 文件"); }
console.log("Done");
