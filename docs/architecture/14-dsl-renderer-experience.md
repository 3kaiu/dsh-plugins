# DSL → HTML 高保真还原:算法经验清单(第一版验证战役)

> 来源:MasterGo MCP 介绍文档(1440×3923,13 section)端到端还原实战。
> 目标:沉淀「确定性规则」,让还原算法对任意标准 DSL 可复现、可审计。
> 原则(不变式):**视觉保真优先**——结构优雅(flex)永远让位于像素一致(absolute 降级);
> 一切「看起来对」必须变成「可断言的数值」。

---

## 0. 最高层经验(战役级)

1. **模型不能读图时,视觉验证必须靠确定性断言**:几何(±2px)、文本命中、溢出、重叠、样式计算值。
2. **每个 DSL 字段都有精确语义,猜错一个整层崩**——本次战役中最贵的三个:
   - `TEXT.fill/_color` = **文字颜色**,不是背景色(色块灾难)
   - `lineHeight` <100 是 **px 绝对值**,≥100 是 **百分比**(行框塌缩灾难)
   - `strokeWidth` 可多边值,`strokeAlign=inside` 意味着**不占布局**(border 挤压灾难)
3. **MCP 数据有三层完整性陷阱**:SVG 被剥离(需 extract-svg)、长文本被 token 化(需整根 DSL 补全)、allTexts 是权威白名单(但代码块除外)。
4. **flex 反推必须回写验证**:flexContainerInfo 是设计意图,显式坐标是设计事实;两者冲突时事实优先(偏差 >2px 降级 absolute)。

---

## 1. 数据获取层(MCP 协议)

| 经验 | 规则 |
|---|---|
| 分片 | `mastergo.com/mcp/design-sections?fileId&layerId` 返回 section 列表(含 rootMetadata / allTexts);带 `sectionIndex=N` 返回单 section 完整 DSL |
| 权威文本 | `allTexts`(列表响应)是文本白名单;但**代码块/占位符不在其中** |
| token 化 | 长文本节点 text = `T4|755:02838` 形式 → 从**整根 getDsl**(`/mcp/dsl`)按节点 id 取真实文本 |
| SVG 剥离 | 响应 `hasStrippedSvgs: true` 表示 PATH 数据被剥离;**必须调 `/mcp/extract-svg`**(page 从 0 开始)拿高精度 SVG,按节点 id(含 GROUP 级)映射 |
| 画布 | `rootMetadata.fill` = 页面根背景;`rootMetadata.width/height` = 画布尺寸 |

## 2. 布局还原层

| 经验 | 规则 |
|---|---|
| flex 回写验证 | 容器有 flexContainerInfo 时:normalize → `simulateFlex` 回写每个子节点 → 与显式 `relativeX/Y` 偏差 ≤2px 才走 flex;否则子节点全部 absolute(显式坐标) |
| padding 字符串 | `"40px"`/`"10px 20px"`/`"8px 12px 4px"`/四值 → 数字数组(top/right/bottom/left,CSS 短语法) |
| gap 字符串 | `"8px 8px"` 取主轴值(row 取第一个,column 取第二个);对象 `{row,column}` 按方向 |
| 混合圆角 | `borderRadius: "8px 24px 24px"` 是 CSS 三值语法,**原样输出**;数组/数字转 px |
| hairline | 宽度明确、高度 0/缺失的块 → `height:1px`(分隔线) |
| 光晕 | ambient-light 是普通 FRAME:半透明 fill + 大 borderRadius + `filter: blur(Npx)`——**真实渲染,不要近似** |
| rotate | `layoutStyle.rotate ≠ 0` → `transform: rotate(deg)` |
| 官方 SVG | 内联时剥掉 `<?xml?>` 声明,用节点 layoutStyle 覆盖 width/height,**保留 viewBox**(缩放保真) |

## 3. 文本渲染层(最容易翻车)

| 经验 | 规则 |
|---|---|
| **文字色 ≠ 背景色** | TEXT 的 `fill/_color` 是文字颜色,只进 `color`;**禁止进 background**——否则每个文本渲染成文字色实心矩形(色块灾难) |
| **lineHeight 单位** | `≥100` → 百分比(`180`→1.8em);`<100` → px 绝对值(`18`→18px)。一律 /100 会让行框塌缩(2.7px),glyph 溢出、文本与图标错位 |
| 渐变文字 | `background-image: linear-gradient(...)` + `-webkit-background-clip:text` + `background-clip:text` + `color:transparent`;**任何 `background:` 简写会重置 clip** |
| 单行判定 | `textMode=single-line`,或设计高度 ≤ 1.6×字号 → `white-space:nowrap`(64px 标题溢出 6px 就断行,整块错乱) |
| 换行文本 | 内容含 `\n` → `white-space:pre`(**优先于 textMode 判断**——token 补全后可能从单行变多行) |
| 语法高亮 | `textColor` 数组(字符区间 start/end/color)→ 按区间 slice 成 `<span style="color:...">` |
| 文字色引用 | TEXT 的 fill 可能是 `paint_xxx` 引用,也可能是 `_color` 直给;渐变也出现在 `_color` |
| 文本尺寸 | 保留 layoutStyle 宽高(布局模拟需要);textMode=single-line 的固定高度按设计值 |
| 字体 | 设计稿字体(Inter)必须 web font 加载——fallback 字形宽度全偏,是"整体不对"的最大嫌疑 |

## 4. 效果层(阴影/描边/模糊)

| 经验 | 规则 |
|---|---|
| effect 两类 | `box-shadow:*` 与 `filter:*` **必须分开输出**——filter 进 box-shadow 无效 |
| 描边 | `strokeColor/strokeWidth/strokeType/strokeAlign` 完整消费;`strokeWidth: "1px 0px 0px"` = 顶部分隔线 |
| 描边实现 | **inset box-shadow 模拟**(`strokeAlign=inside` 不占布局)——border 会挤压内容 1px 且圆角跟随 |
| 合并 | effect 阴影 + stroke 阴影合并进**同一个** `box-shadow`(逗号连接),避免覆盖 |
| 半透明 | `rgba(250,232,255,0.4)` 直给,不要"增强"或近似 |

## 5. 验证层(无读图能力的确定性自检)

| 经验 | 规则 |
|---|---|
| 坐标系 | `getBoundingClientRect` 是视口坐标——body padding/居中会引入**系统性偏移**;以 `#canvas` rect 为原点 |
| section 几何 | 每个 section 画布坐标 ±2px 断言 |
| 内部几何 | 关键节点(标题/图标/卡片)期望位置 ±3px 断言;期望值来自 DSL 坐标链(逐层相加) |
| 文本命中 | TreeWalker 找文本;注意 `text-transform:uppercase` 会改变 innerText;token 补全后再断言 |
| 溢出扫描 | 文本叶子 `scrollWidth/Height > client` → 换行/错位隐患;水平溢出 >3px 必须 nowrap |
| 重叠检测 | 不同内容的叶子文本 bbox 交叠 >25% 面积 → 报错(父容器文本包含子文本是误报,需过滤) |
| 样式探针 | computed style 断言:渐变 clip=text、背景透明、line-height 正确、描边 inset 存在 |
| 字体加载 | `document.fonts.check('16px Inter')`;Google Fonts 需 `display=swap` |
| 回归 | 每轮修复后跑全量:几何 + 溢出 + 重叠 + 字体 + 截图 |

## 6. DSL 字段 → CSS 映射决策表

```
节点(FRAME/GROUP):
  width/height        → width/height(px)
  _color / fill       → background(容器)/ color(文本!)/ 官方 SVG(有 svgKey 时优先)
  borderRadius        → border-radius(多值原样)
  effect              → box-shadow(合并 stroke) / filter(独立)
  stroke*             → inset box-shadow
  opacity             → opacity
  rotate              → transform
  flexContainerInfo   → flex 回写验证通过 → display:flex + gap/padding/justify/align
                         验证失败 → 子节点 absolute(显式坐标)

文本(TEXT):
  text[].text         → 内容(token 时从整根 DSL 补全)
  text[].font         → font-family/size/weight/lineHeight(单位语义!)/letterSpacing/case
  _color / fill       → color(渐变 → background-clip:text)
  textAlign           → text-align
  textMode / 高度     → nowrap / pre / 自动换行
  textColor[]         → 多段 span 高亮
  禁止                → background(文字色灾难)

路径(PATH):path[] → <path d fill>,回退拼 SVG
其他(LAYER):hairline 判定 → 1px
```

---

## 7. 第二战役《改版》新增经验(真实业务稿,375×811 手机 UI,31 sections)

| 经验 | 规则 |
|---|---|
| **废弃图层过滤** | 真实业务稿含被拖出画布的废弃图层:整个 bbox 在画布外(x+width<0 或 x>画布宽,同理 y)→ 跳过并计数 droppedSections(本稿 4 个) |
| **flex 信息可能整体缺失** | 本稿 flexContainerInfo 全缺(0/106)→ absolute 显式坐标保底必须完整可用,与 flex 同精度 |
| **官方 SVG 挂载层级** | svg id = 节点 id,可挂在含文本/图片的容器上。子树含 TEXT 或 LAYER 后代 → **svg 铺底 + children 全部叠加**;纯图形子树(仅 PATH/GROUP)→ 整体替换 |
| **svg 铺底去重** | svgPartial 容器内,children 中无独立官方 svg 的 PATH 跳过渲染(其图形已含在父 svg,重复会遮挡) |
| **defs id 唯一化** | 多个官方 svg 内联后渐变 id(如 grad_paint_40_0160)全局冲突 → 按节点 id 前缀重写 id 与 url(#) 引用 |
| **PATH data 全空** | 本稿 32/32 PATH data 为空(剥离更彻底):无官方 svg 时按几何渲染背景块;path[].fill 支持直接色值与 paint 引用;首个 path 的 matrix 变换解析旋转角(atan2(b,a)) |
| **LAYER 图片** | fill 可为 `{url: "https://image-resource.mastergo.com/...", filters: ""}` → `background-image:url(...); background-size:cover; background-position:center` |
| **fill 数据缺失** | 无 fill/path 字段的细条(高/宽 ≤4px,进度条类)→ 中性灰 #E4E4E4 兜底 + missingFill 计数(经验:数据缺失不阻塞,保守默认 + 记录) |
| **字体缺失回退** | 设计工具内置字体(JoonFont)→ `font-family:'X', 'DIN Alternate', 'Arial Narrow', -apple-system, 'PingFang SC', 'Helvetica Neue', Arial, sans-serif`;数字用窄字体近似,中文自动落 PingFang;已知字体(Inter/PingFang)用普通链 |
| **节点 name 不可靠** | name="本周已学" 实际文本="累计时长"(复制改名残留)→ 一切以 text 内容与字段为准,不信 name |
| **背景参数化** | body/#canvas 背景从 rootMetadata.fill 读(#F3F4F8),不硬编码 |

### 第二轮修复(用户反馈)沉淀

| 经验 | 规则 |
|---|---|
| **状态栏只留安全区** | 手机/Pad 状态栏(顶部)与 Home Indicator(底部)不真实实现:识别时钟文本(^\d{1,2}:\d{2}$)、Battery/信号/状态栏/StatusBar/Indicator 命名 → 整层跳过,只保留位置高度(44px/34px 安全区)。背景层(有 fill 的 section)不受影响 |
| **官方 SVG 坐标系不可信** | extract-svg 导出内容与 DSL 节点几何存在两类不一致:①紧凑导出(viewBox 原点≠0,内容在父坐标系)→ 放大/错位 ②全幅导出但内部元素位置与 DSL 子节点不一致(图标画在 0,0 而 DSL 说 @12,7)→ 图标偏移 |
| **svg 小图形对齐** | 整体替换的 svg:内容中小 path(面积 < svg 40%)union 贴近左上角(≤6px)且 DSL 有 GROUP/FRAME 子节点与之尺寸相近(≠LAYER/PATH,防误伤)→ 给小 path 加 `transform="translate(dx,dy)"`(目标节点左上 - union 左上,|dx/dy|≤50) |
| **svg 铺底覆盖检查** | svgPartial 模式下 children 的 PATH 不再无条件跳过:svg 内 path bbox 与该 PATH 区域相交覆盖率 >50% 才跳过;否则(坐标系错位被裁)保留几何 fallback 渲染背景(取 path[0] 首个非渐变 fill) |
| **误伤防护** | 对齐目标只认 GROUP/FRAME 容器(LAYER/PATH 会被多 bar 图标误匹配);small 判定用面积(单边 55% 会排除 18px 图标主体导致放弃平移) |

### 第八轮修复(学习 tab 图标整体烘焙)沉淀

| 经验 | 规则 |
|---|---|
| **LAYER 与矢量内容必须同一张图** | 图标组里的 LAYER 子节点(如学习 tab 的橙色选中块)与矢量柱条是**一个 icon 的组成部分**——不能 svg 位图 + 独立 LAYER div 分离实现(用户会检查 DOM 结构);要合成为一张 svg → 一张 4x webp |
| **LAYER 转 rect 按 children 顺序定层级** | DSL children 数组顺序 = 绘制顺序(首子=底层):LAYER 排在矢量 PATH 之前 → rect 插在 paths **之前**(底层);排在之后 → 插在 paths 之后。坐标 relativeX/relativeY 即组坐标系 = svg viewBox 坐标,直接映射 |
| **层级错误会翻转视觉** | 之前橙块 div 叠在 img 上 = 橙色盖住柱条中段;正确是柱条在上、橙底在后(柱条间空隙透出橙色)——像素验证:柱条 (16,30,57)、空隙橙 (255,165,32) |

### 第七轮修复(消除冗余定位 wrapper)沉淀

| 经验 | 规则 |
|---|---|
| **定位并入子节点输出** | absolute 容器给每个 child 包一层纯定位 div(`<div style="position:absolute;left;top">`)再放 renderNode 输出——叶子(文本/图形)应把定位**注入**其 style 开头,单层输出(用户对代码结构有洁癖:数字文本两层 div 是坏味道) |
| **注入判定按分号分段** | 判断"输出是否已声明 position"要按 `;` 分段匹配 `^position:`,**不能用 `\bposition\s*:` 正则**——`background-position:center` 会被误匹配,导致带背景图叶子(封面/图标)不合并 |
| **容器 wrapper 也可消除** | 子节点输出为容器(position:relative)时,把 `position:relative` **替换**为 `position:absolute;left;top`(absolute 同样建立子节点定位上下文,语义等价)——整棵树每节点一层 div |
| **data-tpl 占位保留** | 模板实例的空 div(clone 挂载点)与顶层 section 定位 div 是结构性需要的 wrapper,保留 |

### 第六轮修复(整卡烘焙:容器=一张图)沉淀

| 经验 | 规则 |
|---|---|
| **装饰层整卡烘焙** | CSS 组合(渐变+inset 阴影+圆角+blur 图标)还原不出设计稿时,把容器全部装饰合成**一张 svg → 单张 4x webp**,CSS 只叠加动态文本——"整个容器用图"是用户可点名启用的兜底策略 |
| **合成配方** | 背景原 path + 内阴影(克隆背景圆角 path,**保留 d/transform/matrix**,仅换 fill 为顶部 linearGradient 色带,y2≈20/vbH)+ 图标 cluster(path 原坐标,g transform 补偿 DSL 偏差 + feGaussianBlur stdDeviation=cssBlur/2) |
| **克隆 path 必须整条克隆** | 只复制 d 会丢 matrix(镜像/旋转),内阴影形状跑出 viewBox 完全不可见——属性级替换 fill,其余原样 |

### 第五轮修复(统计卡视觉精修:层叠/effect/坐标权威)沉淀

| 经验 | 规则 |
|---|---|
| **inset 阴影层必须在位图之上** | 容器背景位图化后,不透明的 img 会遮住铺底 div 上的 inset box-shadow(圆角内完全不可见,只在圆角外残余)——**内阴影必须是独立覆盖层,排在 img 之后、内容之前**(pointer-events:none) |
| **TEXT 的 effect 要渲染** | MasterGo 数据里 effect 挂在 TEXT 上(如统计卡大数字的淡投影 0 1px 6px #E3DFE4)——box-shadow/filters 都要输出到文本 div,丢失会让数字失去层次 |
| **图标 PATH 的 blur 是真实效果** | 图标(路径 PATH)effect filter: blur(1px) = 设计稿的模糊光晕,要应用到 cluster 容器 |
| **cluster 位置用 DSL 权威坐标** | svg 导出的 path 坐标与 DSL layoutStyle 有 ~2px 系统偏差;子节点(带 filter 的 PATH)存在时,cluster 的 x/y/w/h 覆盖为 DSL 值,svg width/height 属性同步(preserveAspectRatio 等比适配) |
| **组件实例文本取 override** | getDesignSections(rowTexts)返回实例 override 文本(今日学习/连续学习/累计时长),getDsl 单拉返回组件默认文本(累计已学/本周已学)——**以 sections 的 override 为准**,placeholder(_placeholder: true)是动态数据位 |

### 第四轮修复(容器背景位图化)沉淀

| 经验 | 规则 |
|---|---|
| **容器背景也位图化** | "能用图就用图"策略从 ≤64px 小图标扩展到容器级背景:svgPartial 铺底 svg(bgSvg)加 `class="mg-bg"`,运行时与 mg-icon 统一走 4x webp 转换(统计卡背景 112×108 → natural 447×433) |
| **位图化不丢装饰** | 渐变/圆角在 svg path 内 → 随位图保留;inset 内阴影(effect box-shadow)在铺底 div 上 → 叠加在 img 之上;文字/图标(white cluster)为独立层 → 叠加在背景 img 上,互不干扰 |

### 第三轮修复二阶段(统计卡一致性 + 模板 id 唯一)沉淀

| 经验 | 规则 |
|---|---|
| **背景 path 的 matrix 必须计入 bbox** | 判定"背景是否覆盖 PATH children"与"是否超 viewBox"时,path 的 transform matrix(镜像/旋转/平移)必须作用于 bbox——**dbbox 只是未变换坐标**,105:4217 背景 d 在 x=101..203(matrix 变换后正好覆盖卡 0..111.69)。用完整 path 标签匹配(`/<path\\b[^>]*?\\/?>/g`)再分别提取 d 与 transform(只截到 d 引号会丢 transform) |
| **超界平移并入 matrix 而非改 d** | 真正超界(交集 < 面积 40%)的背景 path:有 matrix 时平移并入 e/f;无 matrix 才改 d 坐标 |
| **渐变 stop0 透明 → 白** | 设计稿渐变多为 `rgba(...,0)→ 色`,叠"白底"语义 = 卡内顶部白底部微色;直接替换 stop0 为不透明白(比给容器铺白底方形安全,保留圆角) |
| **内阴影从被覆盖 PATH 读取** | 卡内 inset 光晕(effect box-shadow)在被 svg 覆盖的 PATH children 上;铺底 div 叠加其 box-shadow(统计卡粉/青/紫三色) |
| **模板 id 必须全局唯一** | 每个容器独立 `tplIdx` 会重复输出 tpl-0,运行时 getElementById 取到错误的模板(卡2 底部渲染出课程卡橙色按钮)——用模块级全局计数器 |
| **svgPartial 整体替换保留 LAYER** | ≤64px svgPartial 整体替换时,有 fill 的 LAYER children 是真实内容(学习 tab 的橙色选中块 #FFA621)→ 叠加保留,否则丢选中态 |

### 第三轮修复(位图资产 + 组件复用)沉淀

| 经验 | 规则 |
|---|---|
| **图标位图化策略** | 小图标(≤64px)不用 svg 直接渲染,运行时用 canvas 把 svg 绘制成 **4x webp**(toDataURL quality 0.92,不支持 webp 回退 png)→ 位图保真。**img 必须显式 px 宽高**(父容器无显式尺寸时 width:100% 解析失效,尺寸失控) |
| **svg 内小图形裁剪** | svgPartial 大 svg 内的小 path cluster(面积 < svg 40%)裁剪为独立图标 svg(viewBox=cluster bbox)再位图化,背景保持铺底。**path 的 translate 必须并入 bbox 并从子 svg 移除**(对齐位移不随 d 坐标) |
| **组件复用(模板化)** | 同构兄弟子树(内容指纹相同)输出 `<template>` + 实例 div,脚本 clone。**clone 时重写 id 与 url(#) 引用**(defs 多实例冲突) |
| **内容指纹** | 整体替换 svg 节点用 **svg 内容指纹**(path bbox 序列),不用节点 id(同组件不同实例 id 不同,如 40:0222 vs 40:920);LAYER 用 fill url;TEXT 用文本;PATH 用 "P" |
| **空实例并入** | 组件实例缺数据(无 svg 无 children 的容器)→ 指纹 "E:size",通配并入同尺寸整体替换 svg 组(课程卡 174238 卡2 缺 children/svg → 并入卡1 模板,clone 补齐按钮) |
| **防误伤** | 不同内容的整体替换 svg(如 4 个 tab 图标)靠内容指纹各自独立,绝不并入;通配并入只对单例 E 组生效 |
| **LAYER 残影** | 带 LAYER 子节点的 ≤64px svgPartial 图标(如学习 tab 40:0058)→ 整体替换 + 位图化,children(PATH/LAYER 残影)丢弃 |

## 7.5 第九轮修复(新稿:根节点 svg 分发 + 覆盖层)沉淀

| 经验 | 规则 |
|---|---|
| **svg 挂载点可能是根节点** | 《改版·课程》稿统计卡整块(3 卡背景 + 3 图标 + 底部分隔条)的官方 svg 挂在**根节点(layerId 自身)**上——sections 全是扁平 PATH,无挂载容器;组装脚本检测 `svgs 中 id == layerId` → `draft.rootSvg{svg,x,y,w,h}`(viewBox 坐标即页面坐标) |
| **根 svg 铺底 + 覆盖跳过** | 页面级底层 div(在 sections 之前);被 bbox 覆盖 >50% 的 PATH section 跳过(rootSvgCovered 计数);TEXT section 正常叠加在图上 |
| **覆盖 PATH 的 inset 阴影** | svg 不含 effect(内阴影)→ 独立 CSS 覆盖层:position/尺寸/圆角 + `box-shadow:inset`,排 rootSvg 之后;验证:卡1 顶部内侧 (252,243,243) 粉 / 卡2 (242,247,245) 青 / 卡3 (253,244,253) 紫 |
| **effect 字段双写** | 节点效果字段可能是 `effect` 或 `effects`——读取用 `dsl0?.effects ?? dsl0?.effect` |
| **新稿复用验证** | 同套算法第二稿:16/16 几何、状态栏/底部安全区、模板 1+2、位图 7 张全 4x webp、wrapper 0——**管线对异稿(819×1178 平板 vs 375×811 手机)零改动复用** |

### 第十轮修复(新稿统计卡:旋转卡烘焙 + bbox 长小数)沉淀

| 经验 | 规则 |
|---|---|
| **根 svg 的卡要逐卡烘焙,不能整块直渲** | rootSvg 整块 svg 直渲时:卡背景 path 带 **6° 旋转矩阵**,变换后 bbox 比 DSL 卡大一圈(~157×148 vs 144×134)且位置偏 7px——与直立的 DSL 文本、直角内阴影覆盖层全部错位。正确做法:rootSvg 只留分隔条,**每卡单独合成 svg → mg-bg 位图**(白底 path + 渐变 path + 内阴影渐变 path(克隆背景 path 仅换 fill)+ 图标 path,矩阵平移对齐 DSL 卡/图标坐标) |
| **合成 svg 的 viewBox 用 DSL 卡全局坐标** | path 处于 svg 全局坐标系 → viewBox 必须写 `"178.4 246.16 144 134"`(卡全局框);写局部 `0 0 144 134` 内容全在 viewBox 外 → **整卡渲染全白**。旧稿 path 在局部坐标才用 `0 0 w h` |
| **dbbox 正则长小数 bug** | `/-?\d+\.?\d*/` 会把 `185.80001831054688` 拆成 `185` + `80001831054688` → bbox 全错(旧稿短小数未触发,新稿 14 位长小数触发,卡对齐差 7px)。修复:`/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g` 整体解析;**共用函数改动必须双稿回归**(旧稿 11/11 不变) |
| **旋转卡超界裁剪可接受** | 旋转内容在轴对齐 viewBox 内必然超界被裁(角部),旧稿同款处理,用户验收通过 |
| **statCards 由组装脚本预处理** | 组装脚本解析 rootSvg:按 path 变换后 bbox 中心 x 聚类 3 卡 + 分隔条;卡组内按尺寸分背景(>100px)/图标(≤40px);内阴影色从对应 section 的 inset effect 读 |
| **旋转卡绝不裁切:viewBox = 旋转后 bbox** | 把旋转 6° 的卡塞进 DSL 轴对齐框(144×134)会**四周裁掉 5~6px,圆角/边缘缺失**(用户反馈"越改越差")。正确:viewBox 与 img 尺寸都取**旋转后 bbox**(154.2×145.3),img 定位在 bbox 左上——内容完整不缩放,卡中心自动与 DSL 框中心对齐(±0.1px),文本按 DSL 坐标叠加即自然居中;图标跟随卡(保留 svg 内相对位置,不做 DSL 单独对齐——DSL 图标坐标是未旋转布局框,不可信) |

### 第十一轮修复(播放按钮歪:整体替换 svg 装饰内容居中 + 采样偏移校准)沉淀

| 经验 | 规则 |
|---|---|
| **整体替换 svg 的装饰内容居中** | 小图标 svg(如播放按钮 40×40)中,背景 path(bbox 覆盖 viewBox >90%,如白色圆盘)不动;**装饰 path(明显偏离中心的非铺满小图形)平移对齐 viewBox 中心**:中心偏差 >2px 且装饰尺寸 < viewBox 85% 时,装饰 path 包 `<g transform="translate(dx,dy)">`(屏幕空间平移,path 自身矩阵保留)。tab 图标(偏差 0)/蒙版组/根 svg(不适用:绝对坐标内容)均不触发 |
| **验证像素采样偏移必须 DOM 校准** | 页面截图采样偏移不能写死:canvas 在 900 viewport 下水平居中偏移 = (900-canvas宽)/2(新稿 819 → 40.5,旧稿 375 → 262.5)。写死旧稿 62.5 → 新稿所有采样偏 22px,得出"三角歪在左边缘"的错误结论。正确:先 `getBoundingClientRect` 拿 canvas 偏移,采样用 `(x+ox, y+oy)` |
| **centerSvgDecor 双稿回归** | 旧稿整体替换 svg 装饰均已居中 → 零触发零影响(11/11 不变);新稿仅播放按钮 2 实例触发,三角中心 (357.5,556.5) = 按钮中心 (358,557) ✓ |

### 第十二轮修复(外部图片本地化)沉淀

| 经验 | 规则 |
|---|---|
| **LAYER 位图(fill=paint_x:yyyy 的 url 型)是远程 MasterGo 资源,必须下载本地化** | styles 里 `{"url": "https://image-resource.mastergo.com/..."}` 的 fill 渲染成 `background-image:url(...)` 远程地址——离线/网络差时破图。组装阶段统一处理:收集全部 mastergo URL → md5 命名下载到 fixture `assets/` + `manifest.json` → **替换 stacked-draft.json 中所有 section 的 dsl.styles(递归遍历)为相对路径** → 渲染后 file:// 打开也稳定显示。新旧稿同一批资源(封面图 82×82×2、tab 图标 27×27、50×50 图标) |
| **"一整个图"的排查顺序** | 用户说"怎么是一整个图"时先分辨:①渲染是否用了位图代替 DOM(查 demo.html 结构:文本/图标是否独立 div)②图片资源是否远程加载失败(破图让整体看起来"糊成一张")。tab 栏(词书/课程/直播)本就是设计稿极简形态:白底矢量圆角 + 选中 tab 深色文字+图标、未选中灰色——结构正确,唯一缺陷是远程图片 |

### 第十三轮修复(渐变 stop0 白化 + TEXT 描边 + 装饰居中贴边豁免)沉淀

| 经验 | 规则 |
|---|---|
| **渐变 stop0 透明 → 白化(不只 svgPartial,statCards 合成 svg 也要)** | MasterGo 导出渐变常带 `stop-opacity="0"` 的 stop0(透明叠加白底语义)。svgPartial 的 bgSvg 已白化,statCards 卡合成 svg 的渐变 defs 漏了 → 卡顶部渐变消失变纯白。统一规则:所有烘焙/合成 svg 的 `<stop stop-opacity="0">` → `stop-opacity="1"`(保留自身色值) |
| **TEXT 描边 = -webkit-text-stroke** | TEXT 节点 `strokeColor + strokeWidth`(数字白描边 2.5px outside)是文字描边,渲染为 `-webkit-text-stroke:{width} {color}`。旧稿数字(25/94/67/0)同样带白描边,此前全丢——数字在浅色渐变上对比弱"显示有问题"。双稿统一修复 |
| **装饰居中豁免:贴边不居中** | centerSvgDecor 误伤头像胶囊图标:白色胶囊(42×38)+ 头像圆贴左上角(装饰 bbox (0,0)-(20,20))——设计定位,却被居中到胶囊正中。规则:装饰 bbox 距 viewBox 任一边 < 2px = 设计定位 → 不居中;不贴边(如播放三角 (6,3) 起)才是导出偏移 → 居中 |
| **getComputedStyle 遍历会重复计入父容器** | DOM dump 时父 div(无 font-size,继承 16px)+ 子 div(50px)都会含文本 → 误判"数字双份重叠"。先看 demo.html 源码确认实际 DOM 结构,再判重 |

### 第十四轮修复(统计卡 DSL 直渲:旋转烘焙违背 DSL 权威)沉淀

| 经验 | 规则 |
|---|---|
| **svg matrix 旋转 ≠ 设计意图,DSL 布局框无旋转字段 → DSL 权威,卡正立** | 统计卡 svg path 带 6° 旋转矩阵,但 DSL 矩形 148568 的 layoutStyle 是 144×134 无旋转——旋转是 MasterGo 导出视图的产物。整卡烘焙保留旋转 = 违背 DSL。**改 DSL 直渲**:卡 = div(144×134 @DSL 坐标 + border-radius 13.8px(从 svg path 弧线读半径)+ background-color 白 + background-image 渐变 + box-shadow inset)。旧稿同款烘焙用户接受是因旧稿卡背景 path 本身镜像旋转是设计(封面卡),新稿统计卡不是 |
| **渐变 stop0 透明不白化(有白底 path 时)** | 统计卡渐变 `rgba(246,247,251,0)→#F9F2F2`:卡有白底 path 铺底,透明 stop0 露出白底(设计意图),**白化反而把顶部染成 246,247,251**。白化规则只适用于"渐变直接作为卡背景且无白底"的路径。改直渲后渐变原样 CSS:顶部透明 → 白底透出 |
| **图标效果不能丢:blur 1.2px 要渲染** | 统计卡图标(PATH 路径 2356 等)fill #FFFFFF + `filter: blur(1.2px)`(光晕)。整卡烘焙时忘了带 filter → 图标边缘生硬。直渲:图标 path 独立 svg + 外层 div `filter:blur(0.6px)`(svg blur 半值) |
| **图标位置以 DSL 坐标,非 svg 相对卡位置** | 图标 DSL @194.82,246.48(卡内 16.4,0.32)vs svg 相对卡 (19.2,6.4)——差 6px。svg 导出相对位置不可信,path 矩阵平移对齐 DSL 坐标 |
| **统计卡整体渲染管线迁移** | statCards(逐卡烘焙 svg 位图)→ statDsl(组装脚本从 svg 提取图标 path + DSL 直渲卡片 div)。渲染器 statDsl 分支:卡 div(渐变/inset/圆角 CSS)+ 图标 div(svg + blur);rootSvg 只留分隔条;覆盖层条件改判 statDsl |

### 第十五轮修复(统计区设计意图:卡斜是设计,不是导出误差)沉淀

| 经验 | 规则 |
|---|---|
| **判定"旋转是否设计":看多元素旋转角度是否一致** | 单元素旋转可能误判;多元素对比:统计区 3 张卡背景旋转 sin 0.105/0.105/-0.139(6°/6°/8°——角度不同 = 刻意错落摆放,非统一导出误差);图标独立旋转 sin 0.251/0.103/0.228(14.5°/6°/13°——与卡不同 = 图标独立摆放,不随卡)。**判断:角度各异 = 设计;角度一致且微小 = 可能是导出。** 旧稿统计卡同样旋转且用户接受 → 新稿斜卡恢复 |
| **统计区设计意图(完整)** | ①三张 144×134 圆角卡并排,**分别斜 6°/6°/8°**(活泼错落);卡 = 白底 + 垂直渐变(顶透明→底 F9F2F2/F7F8FA)+ 顶部内阴影(FAE8E8/E6F1ED/FAE8FA 7.2/16.8)②每卡左上角**独立旋转的白色图标**(白旗 14.5°/时钟 6°/书本 13°)带 blur(1.2px)光晕——落在内阴影粉带上形成浅浮雕③卡内直立大数字 50px(黑+白描边 2.5px+投影)+ 单位 min/天(#111E38)+ 底部灰标签(#AAAAAA)④卡下方 3 条渐变分隔条(blur 6px) |
| **卡烘焙 + 图标分离渲染(最终架构)** | 卡:白底+渐变+内阴影烘焙成位图(viewBox=旋转 bbox 不裁切,img=bbox 尺寸,中心自动对齐 DSL 框中心)。图标:独立 svg(保留自身矩阵旋转+fill 白),外层 div `filter:blur(0.6px)`(svg blur 半值),位置=DSL 坐标——不跟卡走。rootSvg 只留分隔条。文本(数字/单位/标签)直立按 DSL |
| **第十四轮"卡正立"是误判** | 上轮把卡改正立违背设计(设计卡斜)。教训:改"算法规则"前先确认"设计意图",用多元素交叉验证;用户说"差得远"时优先怀疑对设计意图的根本误解,而非字段级误差 |

### 第十六轮修复(统计区整块切图:rootSvg 官方导出 = 设计稿原图)沉淀

| 经验 | 规则 |
|---|---|
| **"切图" = 用 rootSvg 官方导出整块位图,不做 path 拆解重建** | 用户对"算法重建卡"不满意("实现太差")→ 需求是**设计稿原图**。rootSvg(挂根节点的官方 svg,如 408:01532 统计区整块 491×152.74)本身就是设计稿该区域的完整矢量导出(卡+图标+分隔条全部在)——直接整块渲染 4x webp 位图铺底 + 文本(数字/单位/标签)叠加 = 最忠实"切图",零重建 |
| **整块切图渲染管线** | 组装:rootSvg 保留完整 svg(不再拆 statCards/statIcons,拆解逻辑降级为 if(false) 历史参考)。渲染:rootSvg div 加 `class="mg-bg"` → 运行时位图化 4x webp;被覆盖的 9 个 PATH section(3 卡+3 图标+3 分隔条)跳过渲染(coverRatio>50%);文本 section 叠加其上 |
| **图标 blur 不可见可不处理** | rootSvg 官方导出不含 filter(extract-svg 剥离滤镜);blur(1.2px) 在 4x 位图上影响微乎其微,接受省略 |
| **选择"重建"还是"切图"的分界** | 图形是**装饰性整块**(统计卡区)→ 官方 svg 整块切图(忠实、省事);图形需要**与动态内容交互**(课程卡封面/播放按钮/文本叠加)→ 拆解重建。用户说"用切图"时优先整块官方导出 |
| **性能** | 整块 491×152.74 → 4x = 1964×611 webp,运行时一次位图化,可接受 |

### 第十七轮(算法审计:svg 不含 effect + 下标/变换/死代码修复)沉淀

| 经验 | 规则 |
|---|---|
| **extract-svg 官方导出 svg 不含 effect** | 内阴影/投影等 effect 是 DSL 层属性,svg 导出不带!→ rootSvg 整块切图后**必须保留 CSS 覆盖层补内阴影**(切图+覆盖层不是双份,覆盖层是唯一来源)。判断"双份"要先确认 svg 里到底有没有该效果 |
| **filter/map 下标错位陷阱** | `tags.map(...).filter(Boolean)` 后下标与原始数组错位——装饰居中判断会指错 path。先 `forEach` 收集 `{i, bb}` 再过滤 |
| **regex 追加属性前检查已有** | 全局 replace 给小 path 加 transform 前检查 `!/transform=/`——已有 matrix 的 path 会获得第二个 transform 属性(无效) |
| **d 复用 path 平移要全替换** | 相同 d 可能被多个 path 复用,`String.replace` 只替换第一个 → `split.join` 全替换 |
| **诊断计数要完整** | flexFallback 之前永不 ++ → absolute 模式计数补上(诊断可比对 flex 决策分布) |
| **死代码及时删除** | 第 16 轮切图方案废弃的拆解逻辑包 if(false) 残留 ~90 行 → 删除(历史留 git) |
| **冗余三元化简** | `official0 && !isContainer ? official0 : (official0 ? align : official0)` → `official0 && isContainer ? align : official0` |

### 第十八轮(算法技术中立化:描述树 + 适配器)沉淀

| 经验 | 规则 |
|---|---|
| **算法输出必须是技术中立描述树,不是 HTML** | 用户明确要求:同算法 Vue/React 都要能实现同等效果。渲染器重构为两段:①`render-dsl.mjs` 决策引擎 → `tree.json`(中立描述树)②`adapter-html.mjs` web 适配器(HTML 只是适配之一)。中立树:布局=数值 x/y/width/height + flex 语义(direction/gap/align/justify/padding);样式=设计值(color/gradient/radius 数值/shadows{inset,x,y,blur,spread,color}/blur/rotate/opacity/stroke/font 结构化);内容=文本值/svg 矢量数据/图片引用/位图化标记(bitmap);复用=component{template,instances} |
| **svg 字符串 = 矢量设计数据,不是树语法** | 中立树允许 svg 内容(任何栈可渲染矢量或转位图);中立性断言扫描时跳过 svg 字段值 |
| **CSS 字符串必须结构化** | box-shadow → {inset,x,y,blur,spread,color}(parseShadow);filter:blur → blur 数值;-webkit-text-stroke → {width,color};border-radius → 数值。**树里不允许出现 `position:absolute`/`px;` 等 CSS 语法**(verify-neutral.mjs 6 项断言扫描) |
| **DSL 字段是字符串,树字段必须数值化** | strokeWidth 来自 DSL 是 "2.5" 字符串 → 树输出 parseFloat。所有树数值字段断言 number |
| **rootSvg 切图仅限"局部区域"** | 整页 svg(viewBox ≥ 页面 90% 宽高)是铺底语义,不是切图;整块切图只用于局部装饰区(统计卡 491×152.74 < 819×1178)。误判会导致整页位图 + 覆盖误判 + 双份渲染 |
| **页面外 section 排除** | 设计稿含画布外残留(整页 svg 导出坐标系负坐标内容,如旧稿 -650 起的矩形/文本)→ 收集时 x<0 或 y<0 的 section 直接排除(不渲染) |
| **中立性可验证** | verify-neutral.mjs:①全树 CSS/HTML/DOM 语法扫描(无泄漏)②kind 合法 ③布局/样式字段全数值 ④shadows/font 结构化 ⑤text 内容合法。双稿 6/6 |

## 8. 已知待办(下一战役)

- 文本垂直对齐语义:单行文本行框=节点高时,文本中心=节点中心(与 DSL 一致);「sender 与图标中心差 9px」是 DSL 布局事实,待与设计稿目检确认
- `describeStructure` padding 字符串崩溃 bug(version-pill 触发),改造 layout-infer 时修复
- 多行文本 lineHeight 用 px 绝对值(如 18px)时,行距正确性待更多样本验证
- 灰度/图案 fill(非纯色/渐变)的解析
- 中文标点/全角字符宽度差异的兜底策略