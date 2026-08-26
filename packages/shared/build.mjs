// @3kaiu/dsh-plugin-kit 构建: esbuild 打包 src/index.ts → dist/index.js(压缩)
// opentype.js(CJS) 动态 require node 内置模块, 需保持 external 让 Node 运行时解析
import { buildBundle } from "../../scripts/esbuild-common.mjs";

await buildBundle("src/index.ts", "dist/index.js", ["util", "buffer", "process"]);
