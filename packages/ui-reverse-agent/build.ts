// @3kaiu/dsh-ui-reverse-agent 构建（TS 版，最终产物仍为压缩 dist/index.js）
import { buildBundle, DSH_EXTERNALS } from "../../scripts/esbuild-common.mjs";
const externals: string[] = [...DSH_EXTERNALS.filter((n: string) => n === "@deepseek-ai/dsh-tools"), "playwright", "playwright-core"];
await buildBundle("src/index.ts", "dist/index.js", externals);
