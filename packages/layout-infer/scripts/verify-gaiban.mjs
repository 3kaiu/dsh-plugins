// verify-gaiban.mjs — 《改版》首页 DSL 还原质量自检
// 用法:node verify-gaiban.mjs [fixtureDir]
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/tmp/pw/package.json");
const { chromium } = require("playwright-core");

const DIR = process.argv[2] || "../../packages/layout-infer/fixtures/mg-gaiban";
const draft = JSON.parse(fs.readFileSync(`${DIR}/stacked-draft.json`, "utf8"));

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--disable-gpu", "--no-first-run"],
});
const page = await browser.newPage({ viewport: { width: 500, height: draft.canvas.height + 60 }, deviceScaleFactor: 2 });
await page.goto(`file://${DIR}/demo.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const origin = await page.evaluate(() => {
  const r = document.getElementById("canvas").getBoundingClientRect();
  return { x: r.x, y: r.y };
});

// 1) 画布背景
const bg = await page.evaluate(() => getComputedStyle(document.getElementById("canvas")).backgroundColor);
console.log(`1. 画布背景: ${bg} (期望 #F3F4F8 = rgb(243, 244, 248))`);

// 2) 关键节点几何(期望值来自 DSL 坐标链)
const checks = [

  ["标题 课程", "课程", { x: 20, y: 52, w: 40, h: 28 }],
  ["电脑上课", "电脑上课", { x: 237, y: 56, w: 56, h: 20 }],
  ["课程卡1 标题", "90天“祖成”英语陪跑课", { x: 120, y: 358, w: 167, h: 22 }],
  ["课程卡2 标题", "明星老师陪你学英语", { x: 120, y: 382, w: 108, h: 17 }],
  ["统计卡1 数字 67", "67", { x: 263, y: 207, w: 34, h: 38 }],
  ["统计卡1 标题", "累计时长", { x: 267, y: 240, w: 48, h: 17 }],
  ["统计卡2 数字 25", "25", { x: 58, y: 207, w: 33, h: 38 }],
  ["统计卡3 数字 94", "94", { x: 164, y: 207, w: 37, h: 38 }],
  ["tab 首页", "首页", { x: 129, y: 764, w: 20, h: 14 }],
  ["tab 学习(精确)", "学习", { x: 226, y: 764, w: 20, h: 14 }, true],
  ["按钮 直播", "直播", { x: 213, y: 688, w: 24, h: 17 }],
];
let iok = 0;
for (const [name, needle, exp, exact] of checks) {
  const r = await page.evaluate(({ needle, ox, oy, expW, expH, exact }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, hit = null;
    while (n = walker.nextNode()) {
      const ok = exact ? n.textContent.trim() === needle : n.textContent.includes(needle) && n.textContent.trim().length <= 40;
      if (ok) { hit = n.parentElement; break; }
    }
    if (!hit) return null;
    let best = hit, bestScore = Infinity;
    for (let el = hit; el && el !== document.body; el = el.parentElement) {
      const b = el.getBoundingClientRect();
      const score = Math.abs(b.width - expW) + Math.abs(b.height - expH);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    const b = best.getBoundingClientRect();
    return { x: b.x - ox, y: b.y - oy, w: b.width, h: b.height };
  }, { needle, ox: origin.x, oy: origin.y, expW: exp.w, expH: exp.h, exact });
  if (!r) { console.log(`✗ ${name}: 未找到`); continue; }
  const pass = Math.abs(r.x - exp.x) <= 3 && Math.abs(r.y - exp.y) <= 3;
  if (pass) iok++;
  console.log(`${pass ? "✓" : "✗"} ${name}: 期望 @${exp.x},${exp.y} → 实际 @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`);
}
console.log(`2. 关键几何: ${iok}/${checks.length} 通过`);

// 3) 图片与 svg 存在性
const assets = await page.evaluate(() => {
  const origin = document.getElementById("canvas").getBoundingClientRect();
  const imgBg = [...document.querySelectorAll("#canvas div")].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.backgroundImage.includes("image-resource.mastergo.com");
  }).map((el) => {
    const b = el.getBoundingClientRect();
    return `${Math.round(b.x - origin.x)},${Math.round(b.y - origin.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
  });
  const svgCount = document.querySelectorAll("#canvas svg").length;
  const cardSvg = [...document.querySelectorAll("#canvas svg")].filter((s) => {
    const b = s.getBoundingClientRect();
    return b.width > 100 && b.height > 100;
  }).length;
  return { imgBg, svgCount, cardSvg };
});
console.log(`3. 图片背景: ${assets.imgBg.join(" | ")}`);
console.log(`   svg: 共 ${assets.svgCount} 个,大尺寸卡背景 ${assets.cardSvg} 个`);

// 4) 废弃图层过滤:画布外不应有内容
const outside = await page.evaluate(() => {
  const origin = document.getElementById("canvas").getBoundingClientRect();
  let n = 0;
  for (const el of document.querySelectorAll("#canvas *")) {
    const b = el.getBoundingClientRect();
    const x = b.x - origin.x, y = b.y - origin.y;
    if (b.width >= 2 && b.height >= 2 && (x < -5 || y < -5 || x + b.width > origin.width + 5)) n++;
  }
  return n;
});
console.log(`4. 画布外残留元素: ${outside} (允许 0)`);

// 5) 文本溢出
const overflow = await page.evaluate(() => {
  let n = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el;
  while (el = walker.nextNode()) {
    if (el.children.length === 0 && el.textContent.trim()) {
      if (el.scrollWidth > el.clientWidth + 3 || el.scrollHeight > el.clientHeight + 3) n++;
    }
  }
  return n;
});
// 6) 状态栏与底部安全区:无内容渲染(仅保留安全区高度)
const chrome = await page.evaluate(() => {
  const origin = document.getElementById("canvas").getBoundingClientRect();
  const top = [], bottom = [];
  for (const el of document.querySelectorAll("#canvas *")) {
    const b = el.getBoundingClientRect();
    const y = b.y - origin.y;
    if (b.width >= 2 && b.height >= 2) {
      if (y >= 0 && y + b.height <= 44 && (el.textContent || "").trim()) top.push(el.textContent.trim().slice(0, 12));
      if (y >= 778 && y + b.height <= 812 && (el.textContent || "").trim()) bottom.push(el.textContent.trim().slice(0, 12));
    }
  }
  return { top, bottom };
});
console.log(`6. 状态栏区文本: ${chrome.top.length ? chrome.top.join("|") : "无(安全区空白 ✓)"} | 底部安全区文本: ${chrome.bottom.length ? chrome.bottom.join("|") : "无 ✓"}`);

// 7) 头部图标组件平移校验:html 源码中 40:0188 的 svg 小图形 translate(12,7)(已位图化,从源码断言)
import { readFileSync } from "node:fs";
const htmlSrc = readFileSync("../../packages/layout-infer/fixtures/mg-gaiban/demo.html", "utf8");
const aligned = htmlSrc.includes("translate(12.00,7.00)");
console.log(`7. 头部图标 svg 平移(源码): ${aligned ? "translate(12.00,7.00) ✓" : "缺失 ✗"}`);

console.log(`5. 文本溢出: ${overflow}`);

await page.screenshot({ path: `${DIR}/demo-full.png`, fullPage: true });
console.log("截图: demo-full.png");
await browser.close();