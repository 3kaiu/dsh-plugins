// 插件注册 mock 测试: 验证三个工具注册且可执行(ctx mock 收敛自 kit test-utils)
import { apply } from "../dist/index.js";
import { mockCtx } from "@3kaiu/dsh-plugin-kit";

const ctx = mockCtx();

apply(ctx);

const registered = ctx.__registeredTools;
const names = registered.map((t) => t.name);
console.log("注册工具:", names.join(", "));
if (!names.includes("infer_layout")) throw new Error("缺少 infer_layout");
if (!names.includes("annotate_layout")) throw new Error("缺少 annotate_layout");
if (!names.includes("clean_layout")) throw new Error("缺少 clean_layout");

const infer = registered.find((t) => t.name === "infer_layout");
if (!infer.execute) throw new Error("infer_layout 缺 execute");
if (!infer.output?.render) throw new Error("infer_layout 缺 output.render");

// 执行 infer_layout: 标题栏(2 子, row 分布)
const layout = await infer.execute(
  {
    container: { width: 375, height: 44 },
    children: [
      { id: "a", x: 20, y: 8, width: 40, height: 28 },
      { id: "b", x: 271, y: 6, width: 88, height: 32 },
    ],
  },
  {},
);
console.log("infer_layout 输出:", JSON.stringify(layout));
if (layout.flexDirection !== "row") throw new Error("应推断为 row");
if (layout.position !== "flex") throw new Error("应推断为 flex");
const content = infer.output.render({}, layout);
if (!Array.isArray(content) || content[0].type !== "text" || !content[0].text.includes("flexDirection")) {
  throw new Error("render 输出应为 text block");
}
console.log("infer_layout render OK ✓");

// 执行 annotate_layout: 简单节点树
const annotateTool = registered.find((t) => t.name === "annotate_layout");
const result = await annotateTool.execute(
  {
    nodes: [
      {
        id: "r",
        name: "root",
        type: "FRAME",
        layoutStyle: { width: 375, height: 44, relativeX: 0, relativeY: 0 },
        children: [
          { id: "a", name: "t", type: "TEXT", layoutStyle: { width: 40, height: 28, relativeX: 20, relativeY: 8 } },
          { id: "b", name: "c", type: "FRAME", layoutStyle: { width: 88, height: 32, relativeX: 271, relativeY: 6 } },
        ],
      },
    ],
  },
  {},
);
console.log("annotate_layout stats:", JSON.stringify(result.stats));
if (result.stats.containers !== 1) throw new Error("应标注 1 个容器");
if (result.stats.flex !== 1) throw new Error("root 应为 flex");
if (!result.tree[0].layout || result.tree[0].layout.flexDirection !== "row") throw new Error("root 应 row");
console.log("annotate_layout 输出 OK ✓");

// 执行 clean_layout: 拍平稿 → 标准 DSL + 结构描述
const cleanTool = registered.find((t) => t.name === "clean_layout");
const cleanOut = await cleanTool.execute(
  {
    canvas: { width: 375, height: 812 },
    sections: [
      { id: "bg", name: "矩形", type: "LAYER", x: 0, y: 0, width: 375, height: 159, dsl: { styles: {}, nodes: [{ type: "LAYER", id: "bg", name: "矩形", layoutStyle: { width: 375, height: 159, relativeX: 0, relativeY: 0 }, _color: "linear-gradient(180deg, #7F7CFF 0%, #79A8FF 100%)" }] } },
      { id: "sb", name: "编组", type: "FRAME", x: 0, y: 0, width: 375, height: 44 },
      { id: "nb", name: "标题", type: "FRAME", x: 0, y: 44, width: 375, height: 44 },
      { id: "card", name: "容器", type: "FRAME", x: 16, y: 200, width: 343, height: 132, dsl: { styles: {}, rowTexts: [{ text: "阿祖陪你学单词" }], nodes: [{ type: "FRAME", id: "card", name: "容器", layoutStyle: { width: 343, height: 132, relativeX: 0, relativeY: 0 }, effect: "box-shadow" }] } },
      { id: "tb", name: "矩形", type: "PATH", x: 0, y: 730, width: 375, height: 82, dsl: { styles: {}, nodes: [{ type: "PATH", id: "tb", name: "矩形", layoutStyle: { width: 375, height: 82, relativeX: 0, relativeY: 0 }, _color: "#FFFFFF" }] } },
      { id: "ic1", name: "容器", type: "FRAME", x: 30, y: 740, width: 24, height: 24 },
      { id: "lb1", name: "对话", type: "TEXT", x: 32, y: 764, width: 20, height: 14, dsl: { styles: {}, rowTexts: [{ text: "对话" }], nodes: [{ type: "TEXT", id: "lb1", name: "对话", layoutStyle: { width: 20, height: 14, relativeX: 0, relativeY: 0 }, text: "对话" }] } },
      { id: "ic2", name: "容器", type: "FRAME", x: 103, y: 740, width: 24, height: 24 },
      { id: "lb2", name: "首页", type: "TEXT", x: 105, y: 764, width: 20, height: 14, dsl: { styles: {}, rowTexts: [{ text: "首页" }], nodes: [{ type: "TEXT", id: "lb2", name: "首页", layoutStyle: { width: 20, height: 14, relativeX: 0, relativeY: 0 }, text: "首页" }] } },
    ],
    rootMeta: { name: "词书", background: "#F6F7FB" },
  },
  {},
);
console.log("clean_layout stats:", JSON.stringify(cleanOut.stats));
if (!cleanOut.dsl || !cleanOut.dsl.root) throw new Error("clean_layout 缺 dsl.root");
if (cleanOut.dsl.root.layoutStyle.width !== 375) throw new Error("root 宽度应为 375");
if (!cleanOut.description || !cleanOut.description.includes("tab-item-对话")) throw new Error("description 应含 tab-item-对话");
if (!cleanOut.description.includes("tab-item-首页")) throw new Error("description 应含 tab-item-首页");
if (/div|css|flexbox|\bView\b/i.test(cleanOut.description)) throw new Error("description 不应含前端技术词汇");
console.log("clean_layout 输出 OK ✓ (描述含语义容器与 tab-item, 无技术词汇)");

console.log("\n插件注册测试全部通过 ✓");