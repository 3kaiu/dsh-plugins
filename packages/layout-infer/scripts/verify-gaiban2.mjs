// 《改版·课程》稿(819×1178)验证:几何/状态栏/位图/组件 —— 期望值全部来自 sections 列表坐标链
// 探针样板(启动/原点/截图/关会话)自 verify-lib 单源消费(批4 收敛)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchProbe } from "./verify-lib.mjs";

const DIR = process.argv[2] || fileURLToPath(new URL("../fixtures/mg-gaiban2", import.meta.url));
const PAGE_URL = `file://${DIR}/demo.html`;
const checks = [
  ["标题 课程", "课程", 34, 53, 0, 0],
  ["课程学习成果", "课程学习成果", 355.5, 196, 0, 0],
  ["统计卡1 数字 25", "25", 218, 277, 43, 50],
  ["统计卡2 数字 94", "94", 368, 277, 49, 50],
  ["统计卡3 数字 67", "67", 516, 277, 44, 50],
  ["统计卡1 标签", "今日学习", 222, 321, 60, 21],
  ["统计卡2 标签", "连续学习", 371, 321, 60, 21],
  ["统计卡3 标签", "累计时长", 521, 321, 60, 21],
  ["我的课程", "我的课程", 34, 433, 64, 22],
  ["课程卡1 标题", "90天", 152, 495, 0, 0],
  ["课程卡1 副标题", "明星老师", 152, 524, 0, 0],
  ["课程卡1 人数", "420人", 152, 560, 0, 0],
  ["tab 对话", "对话", 93, 1125, 28, 47],
  ["tab 首页", "首页", 296, 1125, 28, 47],
  ["tab 学习", "学习", 498, 1125, 28, 47],
  ["tab 我的", "我的", 701, 1125, 28, 47],
];
const { page, origin, screenshotTo, close } = await launchProbe({ url: PAGE_URL, viewport: { width: 900, height: 1300 }, deviceScaleFactor: 1, waitMs: 2500 });
let pass = 0;
for (const [name, needle, ex, ey] of checks) {
  const hit = await page.evaluate(({ needle, ex, ey, ox, oy }) => {
    const walker = document.createTreeWalker(document.getElementById("canvas"), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.textContent.includes(needle)) {
        const b = n.parentElement.getBoundingClientRect();
        const x = b.x - ox, y = b.y - oy;
        if (Math.abs(x - ex) <= 3 && Math.abs(y - ey) <= 3) return { x: Math.round(x), y: Math.round(y), w: Math.round(b.width), h: Math.round(b.height), ok: true };
      }
    }
    return { ok: false };
  }, { needle, ex, ey, ox: origin.x, oy: origin.y });
  if (hit.ok) { pass++; console.log(`✓ ${name}: @${ex},${ey} → @${hit.x},${hit.y} ${hit.w}x${hit.h}`); }
  else console.log(`✗ ${name}: 未命中 @${ex},${ey}`);
}
console.log(`关键几何: ${pass}/${checks.length} 通过`);

// 状态栏(0..44)与底部安全区(1144..1178)文本
const chrome = await page.evaluate(({ ox, oy }) => {
  const walker = document.createTreeWalker(document.getElementById("canvas"), NodeFilter.SHOW_TEXT);
  const out = [];
  let n;
  while ((n = walker.nextNode())) {
    const b = n.parentElement.getBoundingClientRect();
    const y = b.y - oy;
    if ((y < 44 && y >= 0) || y >= 1144) out.push(n.textContent.slice(0, 20));
  }
  return out;
}, origin);
console.log(`状态栏区文本: ${chrome.length ? chrome.join(",") : "无(安全区空白 ✓)"} | 底部安全区文本: ${chrome.filter(t => t).length ? "有" : "无"}`);

// 位图清单
const imgs = await page.evaluate(({ ox, oy }) => {
  return [...document.querySelectorAll("#canvas img")].map((el) => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x - ox), y: Math.round(b.y - oy), w: Math.round(b.width), h: Math.round(b.height), nw: el.naturalWidth, webp: el.src.startsWith("data:image/webp") };
  });
}, { ox: origin.x, oy: origin.y });
console.log(`位图: ${imgs.length} 张,全部 webp: ${imgs.every(i => i.webp)},全部 4x: ${imgs.every(i => i.nw >= i.w * 3.9)}`);
console.log(imgs.map(i => `${i.x},${i.y} ${i.w}x${i.h}`).join(" | "));

// 组件模板
const tpl = await page.evaluate(() => ({
  templates: document.querySelectorAll("template").length,
  dupIds: [...document.querySelectorAll("#canvas [id]")].filter((el, i, arr) => arr.findIndex(x => x.id === el.id) !== i).length,
}));
console.log(`模板: ${tpl.templates}, dupIds: ${tpl.dupIds}`);

// DOM 结构:冗余 wrapper
const html = readFileSync(`${DIR}/demo.html`, "utf8");
const wrappers = (html.match(/<div style="position:absolute;left:[\d.]+px;top:[\d.]+px;"><div/g) || []).length;
console.log(`纯定位 wrapper: ${wrappers}`);

// 统计区整块切图断言:rootSvg 整块 mg-bg 位图 @140,237.76 491x152.74,4x
const slice = await page.evaluate(({ ox, oy }) => {
  const el = [...document.querySelectorAll("#canvas img")].find((i) => i.naturalWidth >= 1900);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: b.x - ox, y: b.y - oy, w: b.width, h: b.height, nw: el.naturalWidth, webp: el.src.startsWith("data:image/webp") };
}, { ox: origin.x, oy: origin.y });
if (slice && Math.abs(slice.x - 140) <= 2 && Math.abs(slice.y - 237.76) <= 2 && Math.abs(slice.w - 491) <= 2 && Math.abs(slice.h - 152.74) <= 2 && slice.nw === 1964 && slice.webp) {
  console.log(`✓ 统计区整块切图 @${slice.x},${slice.y} ${slice.w}x${slice.h} 4x webp`);
  console.log(`统计区切图: 1/1 通过`);
} else {
  console.log(`✗ 统计区整块切图期望 @140,237.76 491x152.74 实际:`, JSON.stringify(slice));
  console.log(`统计区切图: 0/1 通过`);
}

await screenshotTo(`${DIR}/demo-full.png`);
console.log("截图: demo-full.png");
await close();
