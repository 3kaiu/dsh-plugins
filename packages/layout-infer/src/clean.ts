// clean_layout 工具: 拍平稿 → 标准 DSL + LLM 结构描述
// 输入: 设计稿拍平后的扁平 sections(页面绝对坐标碎片, 如 MasterGo 堆叠稿),
//       或任何"只有绝对坐标、无语义结构"的碎片列表。
// 输出: 三段式 ——
//   1) stats: 清洗统计(背景/容器/带状/贴纸/溢出)
//   2) dsl: 标准 DSL 树(语义容器 + relativeX/Y + flexContainerInfo + 渲染字段)
//   3) description: 技术中立的结构描述文本(缩进树, 无任何前端技术词汇),
//      LLM 可直接据此理解布局结构, 再自由选择实现技术(React/Vue/Flutter/...)
import { cleanToStandardDsl, describeStructure } from "@3kaiu/dsh-plugin-kit";
import { defineTool } from "@deepseek-ai/dsh-tools";

const renderJson = (args: any, value: any) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];

const SECTIONS_DESCRIPTION =
  "拍平稿的扁平 section 列表。每个 section 是一个独立的页面碎片(单文本/单图标/单容器/单贴纸),用页面绝对坐标定位。每项: {id?, name?, type?, x, y, width, height, dsl?}。dsl 可选, 是 MasterGo mcp__getDsl/getDesignSections 返回的该 section 完整 DSL(含 styles 表与节点树), 提供文本/图标/填充等渲染细节; 仅传几何信息也能清洗, 但视觉细节会缺失。";

export function applyCleanTool(ctx: any) {
  ctx.tools.register(
    defineTool({
      name: "clean_layout",
      description:
        "把『拍平稿』(只有绝对坐标的扁平碎片列表, 如 MasterGo 堆叠稿的 sections)清洗为标准 DSL 树, 并生成技术中立的结构描述。输出三段: stats(清洗统计)、dsl(标准 DSL: 语义容器树 status-bar/nav-bar/hero/learn-card/sticker-card/stats-row/content-tabs/tab-bar + 每节点相对父容器的 relativeX/relativeY + 容器 flexContainerInfo(flexDirection/justifyContent/alignItems/gap={row,column}/padding=[top,right,bottom,left]) + 叶子保留原始渲染字段(文本/图标svgKey/颜色/效果/旋转)), description(缩进树文本, 供 LLM 直接理解布局结构)。\n\n结果技术中立: 不包含 div/css/flexbox 等任何具体前端技术词汇, LLM 可据此结构自由选择实现技术(React/React Native/Flutter/Vue/小程序/SwiftUI 等)。清洗后每个叶子的页面绝对坐标与输入完全一致(容差 2px)。",
      parameters: {
        canvas: {
          type: "object",
          required: true,
          additionalProperties: false,
          description: "画布尺寸(整个页面的宽高)",
          properties: {
            width: { type: "number", required: true, description: "画布宽度" },
            height: { type: "number", required: true, description: "画布高度" },
          },
        },
        sections: {
          type: "array",
          required: true,
          description: SECTIONS_DESCRIPTION,
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string", description: "节点 id(可选)" },
              name: { type: "string", description: "节点名(可选)" },
              type: { type: "string", description: "节点类型(可选)" },
              x: { type: "number", required: true, description: "页面绝对 x" },
              y: { type: "number", required: true, description: "页面绝对 y" },
              width: { type: "number", required: true, description: "宽度" },
              height: { type: "number", required: true, description: "高度" },
              dsl: { type: "json", description: "该 section 的完整 DSL(styles/nodes/rowTexts), 可选" },
            },
          },
        },
        rootMeta: {
          type: "json",
          description: "根容器元信息 {name?, background?, source?} —— background 为整页背景色, 可选",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderJson,
      },
      execute: async (args) => {
        const result = cleanToStandardDsl({
          canvas: args.canvas,
          sections: args.sections || [],
          rootMeta: args.rootMeta || undefined,
        });
        return {
          stats: result.stats,
          meta: result.meta,
          dsl: { styles: result.styles, root: result.root },
          description: describeStructure(result),
        };
      },
    }),
  );
}