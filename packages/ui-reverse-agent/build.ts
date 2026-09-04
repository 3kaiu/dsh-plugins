// @3kaiu/dsh-ui-reverse-agent 构建（TS 版，最终产物仍为压缩 dist/index.js）
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";
import { execSync } from "node:child_process";
// zod 由宿主 profile 提供（storage-domain 等同实例消费），保持 external 避免 bundle 膨胀与双实例
// @ui-restore/core 运行时解析: 其传递依赖(opentype/pixelmatch/pngjs/yoga/ws/mcp-sdk)随 core 安装, 避免 wasm 风险与双实例
const externals: string[] = [...DSH_EXTERNALS.filter((n: string) => n === "@deepseek-ai/dsh-tools"), "zod", "playwright", "playwright-core", "@ui-restore/core"];
await buildBundle("src/index.ts", "dist/index.js", externals);

// 生成类型定义
console.log("生成类型定义...");
try { execSync("npx tsc -p tsconfig.build.json", { stdio: "inherit" }); } catch (e) { console.warn("类型定义生成有警告，但已生成 .d.ts 文件"); }
console.log("Done");
