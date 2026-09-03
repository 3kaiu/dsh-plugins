#!/usr/bin/env node
// dom-blocks.mjs — Web 渲染探针: URL/本地文件 → 同一次渲染会话产出 文本块清单 + 截图
//
// 定位: Tool 层适配器(不进 core)。补上 Web 渲染体的块清单生产者 —— 此前 {png, textBlocks[]}
// 契约只有 flutter_harness(RenderParagraph 收集)一个实现, Web 闭环里 blockMatchRate 恒为 null。
//
// 契约(与 visual-diff.blockMetrics 对齐, 与 Flutter collectTextBlocks 同构):
//   输出文件 = 裸数组 [{text,x,y,width,height}] —— pipeline.verifyScreenshots / dist/restore.js verify
//   经 readJson 直接消费; 坐标为视口 CSS px(deviceScaleFactor=1), 与截图逐像素同空间。
//
// 用法:
//   node dist/dom-blocks.js <url-or-file> <out.blocks.json> [--png <out.png>] [--width 375] [--height 812] [--wait ms] [--engine auto|playwright|cdp]
//     auto = 系统 Chrome/Edge(裸 CDP, 零依赖)优先, 无则 Playwright —— 与 screenshot.ts 的 auto 语义对齐
//     cdp  = 强制系统浏览器 CDP(无则报错, 不静默换引擎 —— 保确定性时用)
//     png 与块清单来自同一页面会话, 保证坐标与像素可比(不要与 screenshot.ts 混用于同一验证)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
// @ts-expect-error - ws module lacks types
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { findSystemChrome, toUrl } from './browser-launch.ts';
import { flag } from './args.ts';

/** 页内收集脚本: 遍历可见 TEXT 节点 → Range 客户端矩形并集(跨行文本取外接框, 对齐蓝图的整块 TEXT 叶子模型)。
 *  屏蔽 script/style/template; 祖先可见性用 checkVisibility(display/visibility/opacity), 旧内核回退 computedStyle。 */
const EVAL_TEXT_BLOCKS = (() => {
  const fn = () => {
    const isVisible = (el: any) => {
      if (!el.isConnected) return false;
      if (typeof el.checkVisibility === 'function') {
        try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { /* 回退 */ }
      }
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const out = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const text = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const el = n.parentElement;
      if (!el || SKIP.has(el.tagName) || !isVisible(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of range.getClientRects()) {
        if (!r || (r.width <= 0.01 && r.height <= 0.01)) continue;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
        x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
      }
      if (x0 === Infinity) continue;
      const w = Math.round((x1 - x0) * 100) / 100, h = Math.round((y1 - y0) * 100) / 100;
      if (w < 0.5 || h < 0.5) continue;
      out.push({ text, x: Math.round(x0 * 100) / 100, y: Math.round(y0 * 100) / 100, width: w, height: h });
    }
    return JSON.stringify(out);
  };
  return '(' + Function.prototype.toString.call(fn) + ')()';
})();

const sleep = (ms: any) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 会话(零依赖): Node≥22 全局 WebSocket 承载 JSON-RPC; 只用到 Page/Emulation/Runtime 六个方法。
 *  call=带超时的请求-响应; once=单发事件监听(navigate 与 loadEventFired 存在竞态窗口, 调用方自行兜底)。 */
function connectCdp(wsUrl: any, deadlineMs: any) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener('message', (ev: any) => {
    const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
    if (!msg) return;
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`CDP ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      for (const resolve of events.get(msg.method).splice(0)) resolve(msg.params);
    }
  });
  const call = (method: any, params: Record<string, any> = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, deadlineMs);
  });
  const once = (method: any) => new Promise((resolve) => {
    if (!events.has(method)) events.set(method, []);
    events.get(method).push(resolve);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
  return { ready, call, once, close: () => { try { ws.close(); } catch { /* 忽略 */ } } };
}

async function probeWithCdp(bin: any, target: any, outBlocks: any, opts: any) {
  const width = opts.width ?? 375, height = opts.height ?? 812;
  const deadlineMs = opts.timeoutMs ?? 45000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dom-blocks-'));
  // CI 容器缺 sandbox 特权: linux 下补 --no-sandbox/--disable-dev-shm-usage
  const proc = spawn(bin, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });
  let cdp = null;
  try {
    // DevToolsActivePort 文件就绪 = 调试端口已绑定(首行 = port)
    let port = null;
    for (let i = 0; i < 40 && !port; i++) {
      const p = path.join(dir, 'DevToolsActivePort');
      if (fs.existsSync(p)) port = fs.readFileSync(p, 'utf8').split('\n')[0].trim();
      if (!port) await sleep(250);
    }
    if (!port) throw new Error('DevToolsActivePort 未在时限内出现(浏览器未起来?)');
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pageWs = list.find((t: any) => t.type === 'page')?.webSocketDebuggerUrl;
    if (!pageWs) throw new Error('/json/list 中无 page 目标');
    cdp = connectCdp(pageWs, deadlineMs);
    await cdp.ready;
    await cdp.call('Page.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once('Page.loadEventFired');
    const url = await toUrl(target); // SSRF/LFI 校验正典(kit url-guard, 异步 DNS 级)
    await cdp.call('Page.navigate', { url });
    await Promise.race([loaded, sleep(8000)]); // loadEventFired 与监听注册的竞态窗口用超时兜底; 本地静态页通常秒级
    await sleep(opts.waitMs ?? 500);
    const evalRes: any = await cdp.call('Runtime.evaluate', { expression: EVAL_TEXT_BLOCKS, returnByValue: true, awaitPromise: true });
    if (evalRes.exceptionDetails) throw new Error(`页内脚本异常: ${evalRes.exceptionDetails.text}`);
    const blocks = typeof evalRes.result.value === 'string' ? JSON.parse(evalRes.result.value) : evalRes.result.value;
    let pngPath;
    if (opts.png) {
      // captureBeyondViewport 显式关断: 新版 headless 截图默认越出视口采整页文档宽度,
      // 会把 scrollWidth 超出画布(绝对定位负 x 元素等)的页面拍成超宽图 —— 与
      // screenshot.mjs(--window-size 视口截图)及基准 truth 的空间语义不一致。
      const shot: any = await cdp.call('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      pngPath = path.resolve(opts.png);
      fs.mkdirSync(path.dirname(pngPath), { recursive: true });
      fs.writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    }
    fs.mkdirSync(path.dirname(path.resolve(outBlocks)), { recursive: true });
    fs.writeFileSync(outBlocks, JSON.stringify(blocks, null, 1));
    return { engine: 'chrome-cdp', bin, url, count: blocks.length, pngPath, width, height };
  } finally {
    cdp?.close?.();
    if (!proc.killed) proc.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

async function probeWithPlaywright(target: any, outBlocks: any, opts: any) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch {
    throw new Error('无可用探针引擎 — 安装其一: (a)系统 Chrome 自动检测(cdp/auto 默认路径) (b) pnpm add -D playwright && npx playwright install chromium');
  }
  const width = opts.width ?? 375, height = opts.height ?? 812;
  const url = await toUrl(target); // SSRF/LFI 校验正典(kit url-guard, 异步 DNS 级)
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs ?? 30000 });
    await page.waitForTimeout(opts.waitMs ?? 500);
    const blocks = JSON.parse(await page.evaluate(EVAL_TEXT_BLOCKS));
    let pngPath;
    if (opts.png) {
      pngPath = path.resolve(opts.png);
      await page.screenshot({ path: pngPath, clip: { x: 0, y: 0, width, height } });
    }
    fs.mkdirSync(path.dirname(path.resolve(outBlocks)), { recursive: true });
    fs.writeFileSync(outBlocks, JSON.stringify(blocks, null, 1));
    return { engine: 'playwright', url, count: blocks.length, pngPath, width, height };
  } finally {
    await browser.close();
  }
}

/**
 * 探针主入口(probe): target → 块清单落盘 + 可选同源截图。
 * @param {string} target http(s) URL 或本地文件路径
 * @param {string} outBlocks 块清单输出 json(裸数组契约)
 * @param {object} [opts] {png?, width=375, height=812, engine='auto'|'cdp'|'playwright', waitMs=500, timeoutMs}
 */
export async function probe(target: any, outBlocks: any, opts: Record<string, any> = {}) {
  const engine = opts.engine ?? 'auto';
  if (engine === 'playwright') return probeWithPlaywright(target, outBlocks, opts);
  if (engine === 'cdp' || engine === 'auto') {
    const bin = findSystemChrome();
    if (bin) return probeWithCdp(bin, target, outBlocks, opts);
    if (engine === 'cdp') throw new Error('未找到系统 Chrome/Edge(cdp 不回退, 显式 --engine playwright)');
  }
  return probeWithPlaywright(target, outBlocks, opts);
}

// CLI 直跑入口(import 本模块时不执行 —— 与 screenshot.mjs 同款守卫)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const [target, outBlocks] = args;
  if (!target || !outBlocks) {
    console.error('用法: dom-blocks.mjs <url-or-file> <out.blocks.json> [--png <out.png>] [--width 375] [--height 812] [--wait ms] [--engine auto|playwright|cdp]');
    process.exit(1);
  }
  probe(target, outBlocks, {
    png: flag(args, 'png') || undefined,
    width: Number(flag(args, 'width')) || undefined,
    height: Number(flag(args, 'height')) || undefined,
    waitMs: flag(args, 'wait') != null ? Number(flag(args, 'wait')) : undefined,
    engine: flag(args, 'engine') || undefined,
  })
    .then((r) => console.log(`探针完成: ${r.count} 个文本块 → ${outBlocks}${r.pngPath ? ` | 截图 ${r.pngPath}` : ''} (${r.engine})`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}