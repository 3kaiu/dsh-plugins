// dsh-layout-infer 插件核心逻辑测试
// 用纯堆叠稿(408:9584)数据验证 annotate_layout / infer_layout 行为与已验证结果一致
// fixture 已提交在 test/fixtures/(mg-pure-sec-*.json,真实设计稿 30 个 section)
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { annotate } from "../src/layout-infer/annotate.js";
import { inferLayout } from "../src/layout-infer/core.js";

const PREFIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mg-pure-sec-");

// 1. 整树标注: 30 个 section 全部标注
const all = { total: 0, containers: 0, flex: 0, absolute: 0 };
const sections = [];
for (let i = 0; i < 30; i++) {
  const f = PREFIX + i + ".json";
  if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, "utf8"));
  if (!d.dsl || !d.dsl.nodes) continue;
  const stats = { total: 0, containers: 0, flex: 0, absolute: 0 };
  const tree = annotate(d.dsl.nodes, stats);
  for (const k of Object.keys(stats)) all[k] += stats[k];
  sections.push({ i, tree, stats });
}

console.log("=== annotate_layout 全量标注 ===");
console.log("节点总数:", all.total);
console.log("容器:", all.containers);
console.log("flex:", all.flex, "absolute:", all.absolute);
if (all.total !== 132) throw new Error("节点总数应为 132, got " + all.total);
if (all.containers !== 44) throw new Error("容器应为 44, got " + all.containers);
if (all.flex !== 16) throw new Error("flex 应为 16, got " + all.flex);
if (all.absolute !== 28) throw new Error("absolute 应为 28, got " + all.absolute);
console.log("标注统计与验证一致 ✓");

// 2. 抽查容器: 标题栏(sec11)应为 flex row
const sec11 = sections.find((s) => s.i === 11);
const title = sec11.tree.find((n) => n.name.includes("标题"));
if (!title || title.layout.position !== "flex") throw new Error("标题应为 flex");
console.log("标题容器:", JSON.stringify(title.layout));
if (title.layout.flexDirection !== "row") throw new Error("标题应为 row");
console.log("标题 flexDirection=row ✓");

// 3. 抽查贴纸区(sec14 顶层组)应 absolute
const sec14 = sections.find((s) => s.i === 14);
const sticker = sec14.tree[0];
if (!sticker || sticker.layout.position !== "absolute") throw new Error("贴纸区应为 absolute");
console.log("贴纸区 position=absolute ✓");

// 4. infer_layout 单容器: 复现标题容器子节点推断
const raw11 = JSON.parse(readFileSync(PREFIX + "11.json", "utf8"));
const titleRaw = raw11.dsl.nodes.find((n) => n.name.includes("标题"));
const kids = (titleRaw.children || []).map((k) => ({
  id: k.id,
  x: k.layoutStyle.relativeX ?? 0,
  y: k.layoutStyle.relativeY ?? 0,
  width: k.layoutStyle.width,
  height: k.layoutStyle.height,
  rotation: k.layoutStyle.rotate ?? 0,
}));
const inferred = inferLayout({ container: { width: titleRaw.layoutStyle.width, height: titleRaw.layoutStyle.height }, children: kids });
console.log("infer_layout 标题容器:", JSON.stringify(inferred));
if (inferred.flexDirection !== "row" || inferred.position !== "flex") throw new Error("标题推断异常");
console.log("infer_layout 行为一致 ✓");

console.log("\n全部测试通过 ✓");