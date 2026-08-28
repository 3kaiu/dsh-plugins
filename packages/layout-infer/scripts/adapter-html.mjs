// adapter-html.mjs — 中立描述树 → HTML(仅 web 适配器之一)
// ============================================================
// 消费 render-dsl.mjs 输出的 tree.json,生成浏览器可看可验证的 demo.html。
// Vue/React/RN/Flutter/小程序等其它适配器可消费同一棵 tree.json。
// 运行时位图化(icon/image 的 svg → 4x webp)与组件模板实例化是 web 适配器
// 的实现细节,不属于算法本身。
//
// 用法:node adapter-html.mjs [fixtureDir] → demo.html
import fs from "node:fs";

const DIR = process.argv[2] || "/Users/seeu/dev/dsh-opencode-zen/packages/layout-infer/fixtures/mg-demo-2025";
const TREE = `${DIR}/tree.json`;
const OUT = `${DIR}/demo.html`;

const tree = JSON.parse(fs.readFileSync(TREE, "utf8"));
const { canvas, diagnostics } = tree.meta;
const root = tree.root;

// ---------- 数值格式化 ----------
function px(n) { return String(Math.round(n * 100) / 100); }

// ---------- 字体回退(web 适配:设计字体名 → 可用字体栈) ----------
const KNOWN_FONTS = new Set(["Inter", "PingFang SC", "Helvetica", "Arial", "sans-serif", "-apple-system"]);
function fontFamilyCss(family) {
  if (!family) return "";
  if (KNOWN_FONTS.has(family)) {
    return `font-family:'${family}', -apple-system, 'PingFang SC', 'Helvetica Neue', Arial, sans-serif`;
  }
  return `font-family:'${family}', 'DIN Alternate', 'Arial Narrow', -apple-system, 'PingFang SC', 'Helvetica Neue', Arial, sans-serif`;
}

// ---------- 样式字段 → CSS ----------
function shadowCss(s) {
  return `${s.inset ? "inset " : ""}${px(s.x)}px ${px(s.y)}px ${px(s.blur)}px ${px(s.spread)}px ${s.color}`;
}
function radiusCss(r) {
  if (r == null) return "";
  if (Array.isArray(r)) return `border-radius:${r.map((v) => px(v) + "px").join(" ")}`;
  return `border-radius:${px(r)}px`;
}
function bgCss(bg) {
  if (!bg) return "";
  if (typeof bg === "string" && bg.startsWith("url(")) {
    return `background-image:${bg};background-size:cover;background-position:center;`;
  }
  return `background:${bg}`;
}
function styleCss(st, extra) {
  const css = [];
  if (st.bg) css.push(bgCss(st.bg));
  if (st.radius != null) css.push(radiusCss(st.radius));
  if (st.shadows?.length) css.push(`box-shadow:${st.shadows.map(shadowCss).join(",")}`);
  if (st.blur != null) css.push(`filter:blur(${px(st.blur)}px)`);
  if (st.opacity != null) css.push(`opacity:${st.opacity}`);
  if (st.rotate != null) css.push(`transform:rotate(${st.rotate}deg)`);
  if (st.width != null) css.push(`width:${px(st.width)}px`);
  if (st.height != null) css.push(`height:${px(st.height)}px`);
  if (extra) css.push(extra);
  return css.join(";");
}

// ---------- 节点 → HTML(inFlex:父容器为 flex 流式,子节点不绝对定位) ----------
function nodeHtml(n, inFlex) {
  switch (n.kind) {
    case "container": {
      const css = [];
      if (!inFlex) css.push("position:absolute");
      if (!inFlex && n.x != null) css.push(`left:${px(n.x)}px`);
      if (!inFlex && n.y != null) css.push(`top:${px(n.y)}px`);
      if (n.flex) {
        css.push(`display:flex;flex-direction:${n.flex.direction}`);
        if (n.flex.justifyContent && n.flex.justifyContent !== "flex-start") css.push(`justify-content:${n.flex.justifyContent}`);
        if (n.flex.alignItems === "center") css.push("align-items:center");
        else if (n.flex.alignItems === "end" || n.flex.alignItems === "flex-end") css.push("align-items:flex-end");
        if (n.flex.gap) css.push(`gap:${px(n.flex.gap)}px`);
        const [t, r, b, l] = n.flex.padding || [0, 0, 0, 0];
        if (t || r || b || l) css.push(`padding:${px(t)}px ${px(r)}px ${px(b)}px ${px(l)}px`);
      }
      const sc = styleCss(n);
      if (sc) css.push(sc);
      return `<div style="${css.join(";")}">\n${(n.children || []).map((c) => nodeHtml(c, !!n.flex)).join("\n")}\n</div>`;
    }
    case "text": {
      const css = [];
      if (!inFlex) css.push("position:absolute");
      if (!inFlex && n.x != null) css.push(`left:${px(n.x)}px`);
      if (!inFlex && n.y != null) css.push(`top:${px(n.y)}px`);
      if (n.font) {
        const f = n.font;
        if (f.family) css.push(fontFamilyCss(f.family));
        if (f.size) css.push(`font-size:${px(f.size)}px`);
        if (f.weight) css.push(`font-weight:${f.weight}`);
        if (f.lineHeight != null) css.push(f.lineHeight >= 100 ? `line-height:${f.lineHeight / 100}` : `line-height:${px(f.lineHeight)}px`);
        if (f.letterSpacing) css.push(`letter-spacing:${f.letterSpacing}`);
        if (f.decoration) css.push(`text-decoration:${f.decoration}`);
        if (f.case === "uppercase") css.push("text-transform:uppercase");
        if (f.case === "capitalize") css.push("text-transform:capitalize");
      }
      if (n.gradient) css.push(`background-image:${n.gradient};-webkit-background-clip:text;background-clip:text;color:transparent`);
      else if (n.color) css.push(`color:${n.color}`);
      if (n.stroke) css.push(`-webkit-text-stroke:${px(n.stroke.width)} ${n.stroke.color}`);
      if (n.align === "center") css.push("text-align:center");
      else if (n.align === "right") css.push("text-align:right");
      if (n.pre) css.push("white-space:pre");
      else if (n.nowrap) css.push("white-space:nowrap");
      if (n.letterSpacing && !n.font?.letterSpacing) css.push(`letter-spacing:${n.letterSpacing}`);
      if (n.shadows?.length) css.push(`box-shadow:${n.shadows.map(shadowCss).join(",")}`);
      if (n.blur != null) css.push(`filter:blur(${px(n.blur)}px)`);
      if (n.width != null) css.push(`width:${px(n.width)}px`);
      if (n.height != null) css.push(`height:${px(n.height)}px`);
      // 多段高亮(中立表达 → web span)
      let body;
      if (n.highlights?.length) {
        const segs = [];
        let pos = 0;
        for (const h of n.highlights) {
          const t = n.text.slice(pos, h.end);
          if (t) segs.push(h.color ? `<span style="color:${h.color}">${esc(t)}</span>` : esc(t));
          pos = h.end;
        }
        if (pos < n.text.length) segs.push(esc(n.text.slice(pos)));
        body = segs.join("");
      } else {
        body = esc(n.text || "");
      }
      return `<div style="${css.join(";")}">${body}</div>`;
    }
    case "shape": {
      const css = [];
      if (!inFlex) css.push("position:absolute");
      if (!inFlex && n.x != null) css.push(`left:${px(n.x)}px`);
      if (!inFlex && n.y != null) css.push(`top:${px(n.y)}px`);
      const sc = styleCss(n);
      if (sc) css.push(sc);
      return `<div style="${css.join(";")}"></div>`;
    }
    case "icon": {
      const css = [];
      if (!inFlex) css.push("position:absolute");
      if (!inFlex && n.x != null) css.push(`left:${px(n.x)}px`);
      if (!inFlex && n.y != null) css.push(`top:${px(n.y)}px`);
      if (n.width != null) css.push(`width:${px(n.width)}px`);
      if (n.height != null) css.push(`height:${px(n.height)}px`);
      const cls = n.bitmap ? " class=\"mg-icon\"" : "";
      return `<div style="${css.join(";")}">${svgWithClass(n.svg, cls)}</div>`;
    }
    case "image": {
      const css = [];
      if (n.fill === "parent") { css.push("left:0;top:0;width:100%;height:100%"); }
      else {
        if (!inFlex) css.push("position:absolute");
        if (!inFlex && n.x != null) css.push(`left:${px(n.x)}px`);
        if (!inFlex && n.y != null) css.push(`top:${px(n.y)}px`);
        if (n.width != null) css.push(`width:${px(n.width)}px`);
        if (n.height != null) css.push(`height:${px(n.height)}px`);
      }
      css.push("overflow:hidden");
      if (n.svg) {
        const cls = n.bitmap ? " class=\"mg-bg\"" : "";
        return `<div style="${css.join(";")}">${svgWithClass(n.svg, cls)}</div>`;
      }
      if (n.url) {
        return `<div style="${css.join(";")}background-image:url(${n.url});background-size:cover;background-position:center;"></div>`;
      }
      return `<div style="${css.join(";")}"></div>`;
    }
    case "component": {
      return `<template id="${n.id}">${nodeHtml(n.template)}</template>\n${n.instances.map((i) => `<div style="position:absolute;left:${px(i.x)}px;top:${px(i.y)}px;" data-tpl="${n.id}"></div>`).join("\n")}`;
    }
    case "page": {
      return (n.children || []).map((c) => nodeHtml(c, false)).join("\n");
    }
    default:
      return "";
  }
}

// svg 内容注入 class(前可能有 xml 头/注释等任意前缀)
function svgWithClass(svg, cls) {
  const at = svg.indexOf("<svg");
  if (at < 0) return svg;
  return svg.slice(0, at) + svg.slice(at).replace(/^<svg/, `<svg${cls}`);
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------- 运行时:模板实例化 + svg → 高清位图(web 适配细节) ----------
const runtimeScript = `<script>
(() => {
  // 组件模板实例化(复制内容 + 局部 id/url 唯一化)
  document.querySelectorAll("[data-tpl]").forEach((el) => {
    const tpl = document.getElementById(el.getAttribute("data-tpl"));
    if (!tpl) return;
    const copy = tpl.content.cloneNode(true);
    const suffix = "-i" + Math.random().toString(36).slice(2, 8);
    const idMap = new Map();
    copy.querySelectorAll("[id]").forEach((x) => { idMap.set(x.id, x.id + suffix); x.id = x.id + suffix; });
    copy.querySelectorAll("*").forEach((x) => {
      for (const attr of ["fill", "stroke", "filter", "clip-path", "mask"]) {
        const v = x.getAttribute(attr);
        if (v && v.startsWith("url(#")) {
          const key = v.slice(5, -1);
          x.setAttribute(attr, "url(#" + (idMap.get(key) || key) + ")");
        }
      }
    });
    el.replaceWith(copy);
  });
  // svg → 4x 位图(canvas),webp 优先,png 兜底
  const toUrl = (svg, w, h) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = 4;
      const c = document.createElement("canvas");
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      const g = c.getContext("2d");
      g.fillStyle = "#0000"; g.clearRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/webp", 0.92);
      if (url.startsWith("data:image/webp")) resolve(url);
      else { const p = c.toDataURL("image/png"); resolve(p.startsWith("data:image/png") ? p : null); }
    };
    img.onerror = () => resolve(null);
    const str = new XMLSerializer().serializeToString(svg);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(str);
  });
  (async () => {
    for (const svg of document.querySelectorAll("svg.mg-icon, svg.mg-bg")) {
      const w = svg.getAttribute("width") || svg.clientWidth || 24;
      const h = svg.getAttribute("height") || svg.clientHeight || 24;
      const url = await toUrl(svg, w, h);
      if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.style.width = w + "px";
        img.style.height = h + "px";
        img.style.display = "block";
        svg.replaceWith(img);
      }
    }
  })();
})();
</script>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>DSL 还原 demo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #E5E5E5; display: flex; justify-content: center; }
  #canvas { position: relative; width: ${root.width}px; height: ${root.height}px; background: ${root.background || "#FCFCFD"}; overflow: hidden; }
  #canvas svg { display: block; }
</style>
</head>
<body>
<div id="canvas">
${nodeHtml(root)}
</div>
${runtimeScript}
</body>
</html>`;

fs.writeFileSync(OUT, html, "utf8");
console.log("written:", OUT, `${(html.length / 1024).toFixed(1)}KB`);
console.log("诊断:", JSON.stringify(diagnostics));