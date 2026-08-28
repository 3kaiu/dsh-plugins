#!/usr/bin/env node
// screenshot.ts — Web 渲染截图 CLI(d2c 规划 Phase 4: Code → Browser → Screenshot)
//
// 定位: 可选外部能力(Tool 层), 不进 core —— ui-restore/core 保持零宿主依赖。
// 能力实现抽在 ./browser-launch.ts(被 dom-blocks 共享); 本文件只做 CLI 直跑入口。
// 必须保持叶入口: 若被其他 adapter 引用, 多入口 split 会把本文件体挪进共享 chunk,
// dist/screenshot.js 退化为 re-export 壳, CLI 直跑失活(2026-08-29 已修一次)。
//
// 用法:
//   node dist/screenshot.js <url-or-file> <out.png> [--width 375] [--height 812] [--full] [--wait ms] [--engine auto|chrome|playwright]
//   (url 支持 http(s) 与本地文件路径; 本地路径自动转 file://
//    两引擎参数语义见 browser-launch.captureScreenshot 头注释: --full 需 playwright/auto; --wait 于 chrome 记虚拟时间预算)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureScreenshot } from './browser-launch.ts';
import { hasFlag } from './args.ts';

// 库兼容面: 历史上 dist/screenshot.js 同时暴露能力函数(内部已迁 browser-launch)
export { CHROME_CANDIDATES, findSystemChrome, toUrl, captureScreenshot } from './browser-launch.ts';

const args = process.argv.slice(2);

// CLI 直跑入口(import 本模块时不执行)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [target, outPng] = args;
  if (!target || !outPng || hasFlag(args, 'help')) {
    console.error('用法: screenshot.mjs <url-or-file> <out.png> [--width 375] [--height 812] [--full] [--wait ms] [--engine auto|chrome|playwright]');
    process.exit(1);
  }
  captureScreenshot(target, outPng)
    .then((r) => console.log(`截图完成: ${r.outPng} (${r.width}x${r.height}) engine=${r.engine}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
