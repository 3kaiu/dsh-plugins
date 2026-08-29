// verify-lib — 浏览器族验证脚本的共享探针核(doc19 §2.2 批4 收敛)
//
// 收敛前: verify-gaiban/gaiban2/demo 三份各持一份 playwright 启动样板, 且三处
// 硬编码同一条 macOS Chrome 路径(换机器/CI 即失效 —— 典型拷贝漂移)。
// 本模块单点维护: Chrome 探测(macOS/Linux 候选)/启动/网络空闲等待/canvas 原点/
// 整页截图/关会话。文本探针等断言逻辑因 fixture 而异, 留在各脚本内。
//
// 注: playwright-core 为 dev 验证工具依赖, 安装在 /tmp/pw(独立 npm 目录,
// 仓库不引入 workspace 冲突)。
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire("/tmp/pw/package.json");

/** 探测系统 Chrome/Chromium(macOS + 主流 Linux 发行版) */
export function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * 打开 demo.html 探针会话: 等待网络空闲与渲染稳定, 计算 #canvas 原点。
 * @returns {{page, origin:{x,y}, screenshotTo(path), close()}}
 */
export async function launchProbe({ url, viewport, deviceScaleFactor = 1, waitMs = 800 }) {
  const { chromium } = require("playwright-core");
  const executablePath = findChrome();
  if (!executablePath) throw new Error("未找到系统 Chrome/Edge/Chromium(候选清单见 findChrome)");
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu", "--no-first-run"] });
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(waitMs);
  const origin = await page.evaluate(() => {
    const r = document.getElementById("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  return {
    page,
    origin,
    screenshotTo: async (path) => { await page.screenshot({ path, fullPage: true }); },
    close: () => browser.close(),
  };
}
