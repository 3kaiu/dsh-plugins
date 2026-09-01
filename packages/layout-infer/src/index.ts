// dsh-layout-infer: UI 布局反推工具
// 把设计稿裸坐标(absolute)反推为 flex 语义(flexDirection/gap/padding/alignItems),
// 辅助 LLM 在做 UI 还原时直接获得布局结构,而不是从坐标猜。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { inferLayout, domToLayout, compareLayouts } from "@3kaiu/dsh-plugin-kit";
import { annotate } from "./annotate.ts";
import { classifyDsl } from "./classify.ts";
import { applyCleanTool } from "./clean.ts";

const name = "dsh-layout-infer";
const inject = ["tools"];


const renderJson = (args, value) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];

function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "infer_layout",
      description:
        "从一组兄弟节点的绝对坐标 + 容器尺寸,反推该容器的 flex 布局语义。输出技术无关的布局语义(flexDirection/gap/padding/alignItems/justifyContent/position/confidence/absolutes),可映射到任意声明式 UI 技术栈:React/React Native(flexDirection、gap、padding、alignItems、justifyContent、position)、Flutter(Row/Column、spacing、padding、crossAxisAlignment、mainAxisAlignment、Stack+Positioned)、CSS/flex 布局、小程序 WXSS、SwiftUI 等。\n\n输入:容器尺寸 + 子元素相对容器的坐标(x/y/width/height,rotation 非 0 视为绝对定位装饰)。输出:flexDirection=row/column(横向/纵向排列)、gap=主轴子元素间距、padding=[上,右,下,左]、alignItems/justifyContent=对齐、position=flex(可用 flex 还原)|absolute(反写会变形,保持绝对定位)、confidence=置信度、absolutes=应绝对定位的子元素 id。",
      parameters: {
        container: {
          type: "object",
          required: true,
          additionalProperties: false,
          description: "容器尺寸(px)",
          properties: {
            width: { type: "number", required: true, description: "容器宽度" },
            height: { type: "number", required: true, description: "容器高度" },
          },
        },
        children: {
          type: "array",
          required: true,
          description: "兄弟节点相对容器的坐标数组",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: "节点 id(可选)" },
              x: { type: "number", required: true, description: "相对容器左上角 x" },
              y: { type: "number", required: true, description: "相对容器左上角 y" },
              width: { type: "number", required: true, description: "宽度" },
              height: { type: "number", required: true, description: "高度" },
              rotation: { type: "number", description: "旋转角度;非 0 视为绝对定位装饰元素" },
            },
          },
        },
        tolerance: {
          type: "number",
          description: "像素容差(默认 2，DOM 严格模式可传 1)",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderJson,
      },
      execute: (args) => inferLayout({ container: args.container, children: args.children, tolerance: args.tolerance }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "annotate_layout",
      description:
        "递归标注整棵设计稿节点树:对每个容器用 infer_layout 反推 flex 布局语义,输出技术无关的标注树,可映射到任意声明式 UI 技术栈(React/RN/Flutter/CSS/小程序/SwiftUI 等)。每节点含 layout 字段(position/flexDirection/gap/padding/alignItems/justifyContent/confidence)、suggestedName(建议命名)与 children。\n\n输入为设计稿 DSL 节点树(每节点 {id?,name?,type?,layoutStyle:{width,height,relativeX,relativeY,rotate?},children?},relativeX/relativeY 为相对父容器坐标)。返回 {stats, tree}:stats 给出 flex/absolute 容器统计,LLM 可直接按标注树还原到目标框架——flex 容器映射为 Row/Column 等排列容器,gap/padding/对齐映射为对应 API,absolute 容器映射为绝对定位(Stack/Positioned 等)。",
      parameters: {
        nodes: {
          type: "json",
          required: true,
          description: "设计稿节点树数组,递归结构;每节点含 layoutStyle(宽高+相对父坐标)与 children",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderJson,
      },
      execute: async (args) => {
        const stats = { total: 0, containers: 0, flex: 0, absolute: 0 };
        const tree = annotate(Array.isArray(args.nodes) ? args.nodes : [], stats);
        return { stats, tree };
      },
    }),
  );

  applyCleanTool(ctx);

  ctx.tools.register(
    defineTool({
      name: "classify_design",
      description:
        "对设计稿 DSL 做还原决策分类,回答『哪些要用图、哪些用代码实现、哪些由内容撑开、哪些固定尺寸、哪些靠 padding/gap、哪些靠 top/bottom 定位』。每节点输出 kind(container/text/icon/image/shape/spacer)、sizing(main/cross = auto 撑开 | fixed 固定,优先直读 MasterGo 原生 flexContainerInfo.mainSizing/crossSizing 与 textMode)、position(flow 流式 | absolute 绝对定位)、spacing(alignItems 直读 + gap/padding 几何反推),均带 confidence 与 reason;另输出 assets:inlineSvg(可内联的图标路径清单)、images(需导出的切图清单)、texts(文本清单)。\n\n输入为 MasterGo magic-mcp 的 mcp__getDsl 返回的 {styles, nodes, components}(styles 中 paint_xx.value 可为色值/渐变/url),也可传纯几何节点树(此时原生信号缺失,置信度降低)。",
      parameters: {
        dsl: {
          type: "json",
          required: true,
          description: "MasterGo DSL({styles:{paint_755:xxx:{value:[...]},font_xxx:{value:{...}},...}, nodes:[...], components:[]}) 或纯几何节点树数组",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderJson,
      },
      execute: (args) => classifyDsl(args.dsl),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "page_layout_tree",
      description:
        "把浏览器 DOM dump 转为与 annotate_layout 同构的标注树（实现侧布局树），与参考侧 clean_layout/annotate_layout 输出同构，可直接用于 compare_layouts。\n\n输入 domDump 为 browser_dom_dump 的输出（含 viewport 与 tree，tree 每节点 {id,tag,selector,role,rect:{x,y,w,h},text,visible,children,computed:{display,flexDirection,gap,padding,alignItems,justifyContent,position,font*,color,...}}），输出 {canvas, tree, stats}：tree 每节点 {id,name,type,selector,role,layout,suggestedName,rect,children}，layout 含 position/flexDirection/gap/padding/alignItems/justifyContent/confidence/source(computed|inferred)。DOM 自带层级，无需容器吸收/带状聚类，computed 直读优先于几何反推。",
      parameters: {
        domDump: {
          type: "json",
          required: true,
          description: "browser_dom_dump 输出（含 viewport 与 tree）",
        },
        tolerance: {
          type: "number",
          description: "几何反推容差（默认 2，严格 1）",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderJson,
      },
      execute: (args) => domToLayout(args.domDump, { tolerance: args.tolerance }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "compare_layouts",
      description:
        "对比参考布局树与实现布局树，输出结构化差异列表。\n\n输入 referenceTree 与 implementedTree 为两棵标注树（clean_layout/annotate_layout 或 page_layout_tree 的 tree），输出 {matched, missing, extra, mismatches}：missing/extra 为未匹配节点路径，mismatches 每项 {path, prop, expected, actual, delta, priority, confidence}，priority 按 P0(结构/缺失) > P1(gap/padding/对齐) > P2(其他)。用于驱动单假设修复与回归检测。",
      parameters: {
        referenceTree: {
          type: "json",
          required: true,
          description: "参考侧标注树（clean_layout/annotate_layout 的 tree）",
        },
        implementedTree: {
          type: "json",
          required: true,
          description: "实现侧标注树（page_layout_tree 的 tree）",
        },
      },
      output: {
        schema: { type: "json" },
        render: renderJson,
      },
      execute: (args) => compareLayouts({ referenceTree: args.referenceTree, implementedTree: args.implementedTree }),
    }),
  );
}

export { name, inject, apply };
// 供测试与外部工具直接消费的核心逻辑(构建产物同步导出)
export { annotate, annotateNode, suggestName } from "./annotate.ts";
export { classifyDsl, classifyNode, kindOf, sizingOf, positionOf, spacingOf, paintValue, resolvePaint, svgOf } from "./classify.ts";
export { applyCleanTool } from "./clean.ts";
export { domToLayout } from "@3kaiu/dsh-plugin-kit";
export { compareLayouts } from "@3kaiu/dsh-plugin-kit";