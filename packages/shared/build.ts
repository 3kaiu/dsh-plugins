// TS 版构建（最终产物仍为压缩 dist）
// @3kaiu/dsh-plugin-kit 构建: esbuild 打包 src/index.ts → dist/index.js(压缩)
import { buildBundle } from "../../scripts/esbuild-common.mjs";

await buildBundle("src/index.ts", "dist/index.js");
