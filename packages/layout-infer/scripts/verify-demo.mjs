// verify-demo.mjs — DSL 还原质量自检(模型无读图能力时的确定性替代)
// 用法:node verify-demo.mjs [fixtureDir]
// 断言项:section 几何 ±2px、内部关键节点几何 ±3px、文本溢出、真实重叠、字体加载、样式探针
// 探针样板(启动/原点/截图/关会话)自 verify-lib 单源消费(批4 收敛); playwright-core 仍在 /tmp/pw
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launchProbe } from "./verify-lib.mjs";

const DIR = process.argv[2] || fileURLToPath(new URL("../fixtures/mg-demo-2025", import.meta.url));
const draft = JSON.parse(fs.readFileSync(`${DIR}/stacked-draft.json`, "utf8"));
const htmlPath = `${DIR}/demo.html`;

const { page, origin, close } = await launchProbe({
  url: `file://${htmlPath}`,
  viewport: { width: 1500, height: draft.canvas.height + 40 },
  waitMs: 800,
});

// ---------- 1) section 几何(排除 ambient 光晕,它们是越界装饰) ----------
const secs = draft.sections.filter((s) => !s.name.startsWith("ambient-light"));
let ok = 0, fail = 0;
for (const s of secs) {
  const pos = await page.evaluate(({ x, y }) => {
    const els = [...document.querySelectorAll("#canvas > div")];
    const el = els.find((e) => {
      const st = getComputedStyle(e);
      return st.position === "absolute" && Math.abs(parseFloat(st.left) - x) < 1 && Math.abs(parseFloat(st.top) - y) < 1;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }, { x: s.x, y: s.y });
  if (!pos) { console.log(`✗ ${s.name}: 容器未找到`); fail++; continue; }
  if (Math.abs(pos.w - s.width) <= 2 && Math.abs(pos.h - s.height) <= 2) { ok++; }
  else { fail++; console.log(`✗ ${s.name}: 期望 ${s.width}x${s.height} 实际 ${Math.round(pos.w)}x${Math.round(pos.h)}`); }
}
console.log(`1. section 几何: ${ok}/${secs.length} 通过`);

// ---------- 2) 内部关键节点几何(期望值来自 DSL 坐标链) ----------
const checks = [
  ["version-pill '2.0'", "2.0", { x: 1172, y: 96, w: 128, h: 16 }],
  ["hero 渐变标题", "赋予 AI 掌控画布", { x: 324, y: 384, w: 793, h: 71 }],
  ["hero 描述", "这不是一项附加功能", { x: 361, y: 479, w: 720, h: 36 }],
  ["step-num '01'", "01", { x: 135.5, y: 928.5, w: 17, h: 17 }],
  ["step 标题", "新增 MCP 服务配置", { x: 200, y: 913, w: 176, h: 24 }],
  ["cap 卡 title", "Design + Create", { x: 184, y: 1762, w: 312, h: 44 }],
  ["chat sender", "User Command", { x: 224, y: 2822, w: 114, h: 18 }],
  ["chat bubble 文本", "使用 MasterGo MCP", { x: 192, y: 2920, w: 408, h: 58 }],
];
let iok = 0;
for (const [name, needle, exp] of checks) {
  const r = await page.evaluate(({ needle, ox, oy, expW, expH }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, hit = null;
    while (n = walker.nextNode()) {
      if (n.textContent.includes(needle) && n.textContent.trim().length <= 200) { hit = n.parentElement; break; }
    }
    if (!hit) return null;
    // 多段高亮 span 的 bbox 会失真:向上找宽高与期望最接近的祖先
    let best = hit, bestScore = Infinity;
    for (let el = hit; el && el !== document.body; el = el.parentElement) {
      const b = el.getBoundingClientRect();
      const score = Math.abs(b.width - expW) + Math.abs(b.height - expH);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    const b = best.getBoundingClientRect();
    return { x: b.x - ox, y: b.y - oy, w: b.width, h: b.height };
  }, { needle, ox: origin.x, oy: origin.y, expW: exp.w, expH: exp.h });
  if (!r) { console.log(`✗ ${name}: 未找到`); continue; }
  const pass = Math.abs(r.x - exp.x) <= 3 && Math.abs(r.y - exp.y) <= 3 && Math.abs(r.w - exp.w) <= 3 && Math.abs(r.h - exp.h) <= 3;
  if (pass) iok++;
  console.log(`${pass ? "✓" : "✗"} ${name}: 期望 @${exp.x},${exp.y} ${exp.w}x${exp.h} → 实际 @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`);
}
console.log(`2. 内部几何: ${iok}/${checks.length} 通过`);

// ---------- 3) 文本溢出扫描(叶子 div 内容超框) ----------
const overflow = await page.evaluate(() => {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let n;
  while (n = walker.nextNode()) {
    if (n.children.length === 0 && n.textContent.trim()) {
      if (n.scrollWidth > n.clientWidth + 3 || n.scrollHeight > n.clientHeight + 3) {
        out.push(`${n.tagName} ${Math.round(n.scrollWidth - n.clientWidth)}x${Math.round(n.scrollHeight - n.clientHeight)} "${n.textContent.trim().slice(0, 30)}"`);
      }
    }
  }
  return out;
});
console.log(`3. 文本溢出: ${overflow.length} 个 ${overflow.slice(0, 5).join(" | ")}`);

// ---------- 4) 真实文本重叠(不同内容,交叠 >25%) ----------
const overlap = await page.evaluate(() => {
  const rects = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while (n = walker.nextNode()) {
    const t = n.textContent.trim();
    if (!t || t.length > 60) continue;
    const p = n.parentElement;
    if (!p) continue;
    const b = p.getBoundingClientRect();
    rects.push({ t, b, p });
  }
  let count = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], c = rects[j];
    if (a.b.width <= 0 || c.b.width <= 0) continue;
    const ix = Math.max(0, Math.min(a.b.right, c.b.right) - Math.max(a.b.left, c.b.left));
    const iy = Math.max(0, Math.min(a.b.bottom, c.b.bottom) - Math.max(a.b.top, c.b.top));
    const inter = ix * iy;
    const area = Math.min(a.b.width * a.b.height, c.b.width * c.b.height);
    // 同一文本 div 内的多段高亮 span 会 bbox 交叠,是误报
    const sameTextBlock = a.p.parentElement === c.p.parentElement;
    if (area > 0 && inter / area > 0.25 && !sameTextBlock && !a.t.includes(c.t) && !c.t.includes(a.t)) count++;
  }
  return count;
});
console.log(`4. 真实文本重叠: ${overlap}`);

// ---------- 5) 字体加载 + 样式探针 ----------
const probe = await page.evaluate(() => {
  const out = {};
  out.inter = document.fonts.check('16px Inter');
  const findText = (needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while (n = walker.nextNode()) if (n.textContent.includes(needle) && n.textContent.trim().length <= 60) return n.parentElement;
    return null;
  };
  const hero = findText("赋予 AI 掌控画布");
  const cs = hero ? getComputedStyle(hero) : null;
  out.gradient = cs ? `${cs.backgroundImage.slice(0, 60)} / clip:${cs.webkitBackgroundClip}` : "未找到";
  const bubble = findText("使用 MasterGo MCP");
  let bubbleBox = null;
  for (let el = bubble; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.boxShadow && cs.boxShadow !== "none") { bubbleBox = cs.boxShadow; break; }
  }
  out.bubbleStroke = bubbleBox ? bubbleBox.slice(0, 60) : "未找到";
  const sender = findText("User Command");
  const scs = sender ? getComputedStyle(sender) : null;
  out.senderLineHeight = scs ? scs.lineHeight : "未找到";
  return out;
});
console.log(`5. 探针: Inter=${probe.inter} | hero=${probe.gradient} | bubble=${probe.bubbleStroke} | sender行高=${probe.senderLineHeight}`);

await close();