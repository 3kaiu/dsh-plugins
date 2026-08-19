# DSL → HTML 还原算法规范(整合版)

> 来源:两大战役(mg-demo-2025 演示稿 + 《改版》真实业务稿 375×811,31 sections)× 8 轮用户目检反馈。
> 本文是 [[14-dsl-renderer-experience]] 的**算法化整合**:按渲染管线阶段重组全部经验,作为可复用到任意设计稿的规范。
> 实现参照:`packages/layout-infer/scripts/assemble-dsl.mjs`(组装)→ `render-dsl.mjs`(中立描述树 tree.json)→ `adapter-html.mjs`(HTML 适配器)。全部零 fixture 特例。

## 0. 不变式

1. **视觉保真优先**:结构优雅(flex)让位于像素一致(absolute);一切"看起来对"必须变成可断言的数值。
2. **DSL 显式坐标是设计事实,svg 导出内容仅供参考**;冲突时以 DSL 为准(svg 坐标有 ~2px 系统偏差、坐标系不可信)。
3. **能用图就用图**:图标/装饰容器优先位图(4x webp),CSS 只负责动态文本与交互层。
4. **数据缺失不阻塞**:保守默认(#E4E4E4 兜底色等)+ 诊断计数(missingFill/droppedSections),渲染继续。

## 1. 输入与数据获取层

| 规则 | 说明 |
|---|---|
| 数据源 | `stacked-draft.json`(sections 扁平列表 + canvas + rootMetadata)、`dsl-full.json`(整根树,token 文本补全用)、`svgs-official.json`(extract-svg 导出,按节点 id 映射,含 GROUP 级) |
| rootMetadata | `fill` → 页面根背景;`width/height` → 画布尺寸(**参数化,禁止硬编码**) |
| token 化文本 | `text = T4\|755:02838` 形式 → 从整根 DSL 按节点 id 取真实内容 |
| 实例 override 文本 | sections 的 rowTexts 是组件实例 override(权威);单拉 DSL 得到的是组件默认文本;`_placeholder: true` 是动态数据位 |

## 2. 页面组装层(section 级)

| 规则 | 说明 |
|---|---|
| 废弃图层过滤 | 整个 bbox 在画布外 → 跳过 + droppedSections 计数 |
| 系统栏识别(chrome) | 时钟文本 `^\d{1,2}:\d{2}$` / 命名含 Battery\|信号\|StatusBar\|状态栏\|Indicator → 整 section 跳过(chromeSkipped);**只保留安全区高度**(顶部 44px / 底部 34px),不渲染内容;背景层(有 fill)不受影响 |
| **根节点 svg 分发(rootSvg)** | svg 可能挂载在**根节点**(layerId 自身,如统计卡整块 3 卡 + 图标 + 分隔条一张 svg)——组装脚本检测 `svgs 中 id == layerId` 的 svg,把 `{svg,x,y,w,h}`(viewBox 即页面坐标)写入 `draft.rootSvg`;渲染器:① 作为**页面级底层** div 铺底(在 sections 之前);② 被其 bbox 覆盖 >50% 的 **PATH section 跳过渲染**(rootSvgCovered 计数)——svg 已含其图形 |
| **覆盖 PATH 的 inset 阴影补回** | 被 rootSvg 覆盖的 PATH 其 `effect`(inset box-shadow)svg 里没有 → 独立 CSS 覆盖层(position/尺寸/圆角 + inset 阴影),排在 rootSvg 之后、文本之前;effect 字段可能是 `effect` 或 `effects`(**双写兼容**) |
| section 定位 | 每个 section 一个绝对定位 div(结构性 wrapper,允许);内部节点树递归 renderNode |
| **rootSvg 整块切图**(assemble-dsl.mjs,第 16 轮起) | svg 挂根节点(layerId)时:**保留完整 svg**,渲染为整块 4x webp 位图铺底 + 文本叠加 = 设计稿原图(最忠实)。不做 path 拆解重建(拆解逻辑保留为历史参考)。被覆盖 PATH section(coverRatio>50%)跳过渲染 |
| **重建 vs 切图分界** | 图形是**装饰性整块**(统计卡区)→ 整块官方导出切图;图形需**与动态内容交互**(封面/按钮/文本叠加)→ 拆解重建 |
| **图片 URL 本地化** | 递归收集全部 `image-resource.mastergo.com` URL → md5 命名下载到 `assets/` + `manifest.json` → 递归替换 sections 的 dsl(离线可显示,file:// 打开稳定) |
| **嵌套 section 收集** | section 不一定是根的直子:整树递归,凡 id 有 sec 分片的节点都收为 section,页面坐标 = 父链 relativeX/Y 累加(嵌套 section 的 x/y 相对父容器) |

## 3. 节点渲染决策管线(renderNode)

按顺序判定,先命中先走:

### 3.1 公共样式(base)
`size(w/h)` → `_color/fill`(容器 background / **TEXT 是 color!** / LAYER 图片 url→background-image+cover) → `borderRadius`(多值原样) → `effect`(box-shadow 与 filter **分开**) → `stroke`(inset box-shadow 模拟,不占布局) → `opacity` → `rotate`。

### 3.2 官方 SVG 决策
节点有官方 svg(`officialSvgFor` 按 id 查 Map)时:

```
子树含 TEXT/LAYER 后代?
├─ 否(纯图形)→ 整体替换:
│    ≤64px → mg-icon 位图化(3.4)
│    >64px → 原样内联(剥 <?xml?>,节点尺寸覆盖 width/height,保留 viewBox)
└─ 是(svgPartial)→
     ≤64px → 合成整体替换:LAYER 子节点按 children 顺序转 rect
             (首子=底层,插在矢量 paths 之前;坐标=组坐标系=viewBox 坐标)
             → mg-icon 位图化(一个 icon 一张图)
     >64px → 铺底 + 内容叠加:
             ① extractIconClusters:小 path cluster(面积<svg 40%)裁剪为独立图标
             ② 整卡烘焙 composeCardSvg:背景 path + 内阴影(克隆背景圆角 path,
                保留 d/transform/matrix,仅换 fill 为顶部渐变色带 y2≈20/vbH)
                + 图标 cluster(g transform 补偿 DSL 偏差 + feGaussianBlur=cssBlur/2)
                → mg-bg 一张位图
             ③ 动态文本/图片 children 叠加在图上
| **统计卡烘焙(statCards)与独立图标(statIcons)** | 根 svg 拆解出的卡:白底 path + 渐变 path(defs 原样,**stop0 透明保留**=白底透出)+ 内阴影(克隆白底 path 换顶部渐变带,fill=url(#cN_inset),viewBox=matrix 变换后 bbox → **旋转卡不裁切**,img 尺寸=bbox,中心自动对齐 DSL 框中心)。图标:独立 svg(保留自身旋转 matrix,fill 白),外层 div `filter:blur(cssBlur/2)`(svg blur 半值),位置=DSL section 坐标——**不跟卡走** |
```

### 3.3 svg 坐标系修正(导出不可信)
| 修正 | 规则 |
|---|---|
| 小图形对齐 | 整体替换 svg 内小 path(面积<40%)union 贴左上(≤6px)且 DSL 有 GROUP/FRAME 子节点尺寸相近 → `translate(dx,dy)`;目标 bbox 必须完整落在挂载节点内;**目标只认 GROUP/FRAME**(LAYER/PATH 误伤 tab 图标) |
| matrix 计入 bbox | 覆盖检查与超界判定必须用 **matrix 变换后的 bbox**(dbbox 只是未变换坐标;匹配用完整 path 标签,只截到 d 引号会丢 transform) |
| 超界平移 | 真正超界(交集<面积 40%)的背景 path:有 matrix → 平移并入 e/f;无 matrix → 改 d 坐标 |
| 渐变 stop0 白化 | `stop-opacity="0"` 的 stop0 → 不透明白,**仅当渐变直接作背景且无白底 path 时**(svgPartial bgSvg 路径);有白底 path 铺底时(statCards 烘焙)**透明保留** = 白底透出(设计意图) |
| PATH 覆盖过滤 | svgPartial 内 children 的 PATH:svg path bbox(matrix 后)覆盖该 PATH 区域 >50% → 跳过(图形已含在父 svg);否则几何 fallback(首个非渐变 fill) |
| cluster 坐标权威 | 图标 cluster 位置/尺寸以 DSL 子节点(带 filter 的 PATH)layoutStyle 覆盖 |

### 3.4 位图化(4x webp)
`svg.mg-icon, svg.mg-bg` → 运行时 canvas → `toDataURL("image/webp", 0.92)`(不支持回退 png)→ `<img>`。
**img 必须显式 px 宽高**(父容器无显式尺寸时 width:100% 失效)。

### 3.5 容器布局
```
有 flexContainerInfo → normalize → simulateFlex 回写子节点 → 与显式 relativeX/Y 偏差 ≤2px?
├─ 是 → display:flex + flexDirection/gap/padding/justify/align
└─ 否 → absolute:每个 child 显式坐标(与 flex 同精度;flex 信息可能整体缺失,absolute 保底)
```
absolute 子节点输出用 **withPos 定位注入**(3.7)。

### 3.6 同构组件(复用)
| 步骤 | 规则 |
|---|---|
| 指纹 | 整体替换 svg 节点 = svg 内容指纹(path bbox 序列,非节点 id);TEXT=文本;LAYER=fill url;PATH="P";纯容器忽略子结构 |
| 分组 | 同指纹兄弟 ≥2 → `<template>` + 实例占位 div(data-tpl);**模板 id 全局计数器唯一**(每容器独立计数会 id 冲突 → clone 取错模板) |
| 空实例并入 | 无 svg 无 children 的容器 → 指纹 "E:size";单例 E 组通配并入同尺寸 S 组(组件实例缺数据,clone 补齐);不同内容的 S 组绝不并入(tab 防误伤) |
| clone | 运行时 clone 模板 → 重写 id(后缀 -iN)与 url(#) 引用(defs 冲突) |

### 3.7 输出结构(无冗余层)
- 叶子输出(文本/图形/图片)→ 定位**注入** style 开头,单层 div
- 容器输出(position:relative)→ 替换为 `position:absolute;left;top`(等价建立定位上下文)
- 注入判定**按分号分段**匹配 `^position:`(`\bposition\s*:` 会误匹配 background-position)
- 保留:template 实例占位 div、顶层 section 定位 div

### 3.8 TEXT 叶子
文字色(≠背景!)→ color;渐变 → background-clip:text;lineHeight **<100=px / ≥100=%**;单行(single-line 或 高≤1.6×字号)→ nowrap;含 \n → pre;token 补全;`effect` 的 box-shadow/filter **要渲染**(数字投影);textColor 数组 → span 高亮;未知字体 → 窄字体回退链 `'X','DIN Alternate','Arial Narrow',-apple-system,'PingFang SC',...`。

### 3.9 PATH / LAYER
PATH data 空 → 几何 div(path[].fill 直色/paint 引用;首个 path matrix 解析旋转角);细条(≤4px)无 fill → #E4E4E4 兜底;LAYER 图片 fill `{url}` → background-image cover;hairline(高 0/缺失)→ 1px。

## 4. 运行时脚本层(页面尾部)

```
1. [data-tpl] 实例 → clone 模板 → id/url(#) 唯一化 → 挂载
2. svg.mg-icon, svg.mg-bg → canvas 4x webp → <img>(显式 px 尺寸)
```

## 5. 验证层(无读图能力的确定性自检)

| 断言 | 方法 |
|---|---|
| 坐标系 | 以 `#canvas` rect 为原点(getBoundingClientRect 是视口坐标) |
| 几何 | section ±2px;关键节点 ±3px(期望值 = DSL 坐标链逐层相加) |
| 位图 | img 位置/尺寸 = DSL;naturalWidth = 4×CSS;src 以 data:image/webp 开头 |
| 文本 | 命中(注意 uppercase);溢出 scrollWidth>client(>3px 报);重叠 >25% 面积报错 |
| 像素 | 采样点 RGB 断言(**索引必须取整**——62.5 浮点偏移会字节错位读到"绿色") |
| 源码 | translate 平移等用 readFileSync 断言(file:// 下 fetch 被 CORS 拒) |
| DOM 结构 | 冗余 wrapper 计数=0;template id 唯一;dupIds=0 |
| 回归 | 每轮修复后全量重跑 |

## 7. 设计意图判定(改算法前先验证设计)

| 规则 | 说明 |
|---|---|
| **多元素旋转角度交叉验证** | 单元素旋转可能误判;多元素对比:统计区 3 卡背景旋转 sin 0.105/0.105/-0.139(6°/6°/8°——角度不同 = 刻意错落,非统一导出误差);图标独立旋转 14.5°/6°/13°(与卡不同 = 独立摆放)。**角度各异 = 设计;角度一致且微小 = 可能是导出。** 卡斜 6°/6°/8° + 图标独立旋转 + 文本直立 = 统计区完整设计意图 |
| **svg 坐标系 ≠ DSL 布局框** | 卡/图标在 svg 里带旋转矩阵(导出视图);DSL 布局框轴对齐、无旋转字段。**旋转信息只在 svg matrix,文本只在 DSL。** 渲染:图形按 svg(斜),文本按 DSL(直立) |
| **"差得远"时先怀疑设计意图误解** | 用户持续不满时,优先重新理解设计(拆 svg 全 path + 对比旧稿可接受设计),而非字段级修补 |

## 6. 中立描述树规格(render-dsl.mjs 输出,tree.json)

算法输出为技术无关 JSON,任何声明式技术栈(Vue/React/RN/Flutter/小程序)消费同一棵树:

```
{ meta: { canvas:{width,height,background}, diagnostics, format:"neutral-render-tree-v1" },
  root: { kind:"page", width, height, background, children:[...] } }
```

| kind | 字段 | 说明 |
|---|---|---|
| container | x,y,width,height, flex{direction,justify,align,gap,padding:[t,r,b,l]}, bg(color/gradient/url), radius(数值/数组), shadows[], blur, opacity, rotate, children | 定位容器;flex 存在时子节点流式排列,否则绝对定位 |
| text | x,y,width,height, text, font{family,size,weight,lineHeight,letterSpacing,decoration,case}, color/gradient, stroke{width,color}, shadows[], blur, align, nowrap, pre, highlights[{start,end,color}] | 文本(多段高亮中立表达) |
| shape | x,y,width,height, bg, radius, shadows[], blur, opacity, rotate | 纯色块(覆盖层/背景) |
| icon | x,y,width,height, svg, bitmap | 矢量图形;bitmap=true 建议位图化 |
| image | x,y,width,height, svg/url, fill("parent"), bitmap | 切图/位图铺底 |
| component | template(节点), instances[{x,y}] | 同构复用(适配器实现组件机制) |

- **shadows 结构化**:`{inset:boolean, x,y,blur,spread:number, color}`(parseShadow 解析 box-shadow)
- **radius 数值化**:`borderRadius` 字符串/数组 → number | number[]
- **font 结构化**:family/size/weight/lineHeight(≥100 为百分比)/letterSpacing/decoration/case
- **svg 字段 = 矢量设计数据**(树中允许;技术栈可渲染或转位图)
- 禁止:任何 CSS 语法字符串(position:/display:/px; 等)、DOM API、HTML 标签(verify-neutral.mjs 断言)

## 7. 已知待办

- 文本垂直对齐语义(单行行框=节点高)
- 多行 lineHeight px 绝对值的行距正确性
- 灰度/图案 fill 解析
- 中文标点/全角字符宽度兜底
