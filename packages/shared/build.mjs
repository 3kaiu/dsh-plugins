// @3kaiu/dsh-plugin-kit 构建: esbuild 打包 src/index.ts → dist/index.js(压缩)
import { buildBundle } from "../../scripts/esbuild-common.mjs";

await buildBundle("src/index.ts", "dist/index.js");
