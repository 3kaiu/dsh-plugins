// dsh-layout-infer: UI 布局反推工具
// 把设计稿裸坐标(absolute)反推为 flex 语义(flexDirection/gap/padding/alignItems),
// 辅助 LLM 在做 UI 还原时直接获得布局结构,而不是从坐标猜。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { inferLayout } from "@3kaiu/dsh-plugin-kit";
import { annotate } from "./annotate.js";
import { classifyDsl } from "./classify.js";
import { applyCleanTool } from "./clean.js";

const name = "dsh-layout-infer";

const renderJson = (args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }];

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
      },
      output: {
        schema: { type: "json" },
        render: renderJson,
      },
      execute: (args) => inferLayout({ container: args.container, children: args.children }),
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
      execute: (args) => {
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
}

export { name, apply };