// 插件注册 mock 测试: 模拟 ctx.tools.register,验证两个工具注册且可执行
import { apply } from "../dist/index.js";

const registered = [];
const disposers = [];
const ctx = {
  tools: {
    register(def) {
      registered.push(def);
      disposers.push(() => {});
      return () => {};
    },
  },
};

apply(ctx);

const names = registered.map((t) => t.name);
console.log("注册工具:", names.join(", "));
if (!names.includes("infer_layout")) throw new Error("缺少 infer_layout");
if (!names.includes("annotate_layout")) throw new Error("缺少 annotate_layout");

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

console.log("\n插件注册测试全部通过 ✓");