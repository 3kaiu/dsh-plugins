// browser-launch — 浏览器渲染能力共享层(自 adapters/screenshot.ts 抽出)
//
// 动机(2026-08-29): 多入口 split 构建下 screenshot.ts 同时是 dist 入口又被 dom-blocks 引用,
// 整个模块体被挪进共享 chunk —— dist/screenshot.js 退化为纯 re-export 壳, CLI 直跑失活
// (isMain 守卫比对的是 chunk 的 import.meta.url)。抽出被共享的能力后, screenshot.ts 恢复
// 纯 CLI 叶入口, 守卫回到自己 entry 内。
// 引擎自动选择: 系统 Chrome/Edge headless(零安装, 默认) → Playwright(未装则跳过提示)。
// 注意: 本模块以库形态被 screenshot/dom-blocks 两个 CLI 复用; flag() 的 args 兜底读取
// 宿主 process.argv(与抽出前行为一致) —— 库调用方应显式传 opts。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { flag, hasFlag } from './args.ts';

const args = process.argv.slice(2);

// 共享给 dom-blocks(CDP 引擎同一套浏览器发现逻辑) — 覆盖 macOS/主流 Linux 发行版
export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/opt/google/chrome/google-chrome',
];

export function findSystemChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

export function toUrl(target, opts = {}) {
  if (/^https?:\/\//i.test(target)) {
    // SSRF 防护: 拒绝内网/元数据地址(设计稿预览 URL 不应指向本地服务或云元数据端点)
    let host = '';
    try { host = new URL(target).hostname.toLowerCase(); } catch { throw new Error(`非法 URL: ${target}`); }
    const blocked = ['localhost', '0.0.0.0', '[::1]', '::1', 'metadata.google.internal', 'metadata.internal']
      .some((h) => host === h || host.endsWith('.localhost') || host.endsWith('.internal'));
    if (blocked || /^169\.254\./.test(host) || /^127\./.test(host) || host === '::1') {
      throw new Error(`拒绝访问内网/元数据地址: ${host}`);
    }
    return target;
  }
  // file:// —— 拒绝读取敏感系统文件(LFI 防护); 普通渲染产物路径不受影响
  const abs = path.resolve(target);
  const SENSITIVE = ['/etc/', '/proc/', '/sys/', '/root/', '/private/etc/', '/windows/system32/'];
  const lower = abs.toLowerCase();
  if (SENSITIVE.some((p) => lower.startsWith(p)) || lower.includes('/.ssh/') || lower.includes('\\.ssh\\')) {
    throw new Error(`拒绝访问敏感系统路径: ${target}`);
  }
  if (!fs.existsSync(abs)) throw new Error(`目标不存在: ${abs}`);
  return `file://${abs}`;
}

/** 引擎一: 系统 Chrome/Edge headless(零安装) */
function captureWithChrome(bin, target, outPng, opts) {
  const width = opts.width ?? Number(flag(args, 'width')) ?? 375;
  const height = opts.height ?? Number(flag(args, 'height')) ?? 812;
  // 等待近似(审计修复): chrome 引擎无 waitForTimeout, 以虚拟时间预算承载 --wait,
  // 默认仍为 4000ms; 再小也至少给 4s 保底动态页面稳定
  const waitMs = opts.waitMs ?? Number(flag(args, 'wait'));
  const virtualBudget = Math.max(4000, waitMs ?? 0);
  if (opts.fullPage ?? hasFlag(args, 'full')) {
    throw new Error('chrome-headless 引擎不支持整页截图(--full): 改用 --engine auto(会自动切 playwright)或显式 --engine playwright');
  }
  const url = toUrl(target);
  fs.mkdirSync(path.dirname(path.resolve(outPng)), { recursive: true });
  execFileSync(bin, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${width},${height}`,
    `--screenshot=${path.resolve(outPng)}`,
    `--virtual-time-budget=${virtualBudget}`,
    url,
  ], { stdio: 'pipe', timeout: opts.timeoutMs ?? 45000 });
  if (!fs.existsSync(outPng)) throw new Error('截图失败: Chrome 未产出文件');
  return { engine: 'chrome-headless', bin, url, outPng: path.resolve(outPng), width, height };
}

/** 引擎二: Playwright(可选 peerDependency, 未装给出安装提示) */
async function captureWithPlaywright(target, outPng, opts) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('无可用截图引擎 — 安装其一: (a)系统 Chrome 自动检测 (b) pnpm add -D playwright && npx playwright install chromium');
  }
  const width = opts.width ?? Number(flag(args, 'width')) ?? 375;
  const height = opts.height ?? Number(flag(args, 'height')) ?? 812;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(toUrl(target), { waitUntil: 'networkidle', timeout: opts.timeoutMs ?? 30000 });
    await page.waitForTimeout(opts.waitMs ?? Number(flag(args, 'wait')) ?? 800);
    fs.mkdirSync(path.dirname(path.resolve(outPng)), { recursive: true });
    await page.screenshot({ path: outPng, fullPage: opts.fullPage ?? hasFlag(args, 'full') });
    return { engine: 'playwright', url: toUrl(target), outPng: path.resolve(outPng), width, height };
  } finally {
    await browser.close();
  }
}

/**
 * 截图能力(d2c Phase 4): 目标 URL/本地文件 → PNG。
 * 参数语义两引擎对齐(审计修复: 此前 --wait/--full 在默认 chrome 引擎下被静默忽略):
 *   --wait ms → chrome=虚拟时间预算(max 4000), playwright=渲染后等待;
 *   --full    → 仅 playwright 支持; chrome 显式拒绝、auto 自动切 playwright。
 * 引擎选择(--engine): auto=系统Chrome优先(无 --full 时),缺则/需整页则 Playwright。
 */
export async function captureScreenshot(target, outPng, opts = {}) {
  const engine = opts.engine ?? flag(args, 'engine') ?? 'auto';
  const wantsFullPage = !!(opts.fullPage ?? hasFlag(args, 'full'));
  if (engine === 'chrome') {
    const bin = findSystemChrome();
    if (!bin) throw new Error('未找到系统 Chrome/Edge(候选: ' + CHROME_CANDIDATES.slice(0, 3).join(', ') + ')');
    if (wantsFullPage) throw new Error('chrome-headless 不支持 --full 整页截图 —— 用 --engine auto(自动切 playwright)或去掉 --full 只截视口');
    return captureWithChrome(bin, target, outPng, opts);
  }
  if (engine === 'auto') {
    const bin = findSystemChrome();
    if (bin && !wantsFullPage) return captureWithChrome(bin, target, outPng, opts);
    // 无系统 Chrome, 或需要整页截图 → playwright(auto 语义下自动降级/升级)
  }
  return captureWithPlaywright(target, outPng, opts);
}
