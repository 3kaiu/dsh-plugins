// @3kaiu/dsh-ui-reverse-agent 构建（TS 版，最终产物仍为压缩 dist/index.js）
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";
import { execSync } from "node:child_process";
// zod 由宿主 profile 提供（storage-domain 等同实例消费），保持 external 避免 bundle 膨胀与双实例
const externals: string[] = [...DSH_EXTERNALS.filter((n: string) => n === "@deepseek-ai/dsh-tools"), "zod", "playwright", "playwright-core"];
await buildBundle("src/index.ts", "dist/index.js", externals);

// 生成类型定义
console.log("生成类型定义...");
try { execSync("npx tsc -p tsconfig.build.json", { stdio: "inherit" }); } catch (e) { console.warn("类型定义生成有警告，但已生成 .d.ts 文件"); }
console.log("Done");
