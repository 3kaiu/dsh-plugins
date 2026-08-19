# UI 还原算法提炼(12)

> 从 `@3kaiu/dsh-plugin-kit`(`layout-core.ts` / `dsl-clean.ts`)与 `dsh-layout-infer`(`classify.ts` / `annotate.ts`)提炼。
> 目标:让任何 agent 能独立复现这套"设计稿 → 技术中立结构"的算法,不必读源码。
> 不变式:**视觉保真优先**——任何推断结果都必须能模拟回写验证,偏差超过 2px 就降级为绝对定位,绝不为了"好看的结构"牺牲像素级一致。

## 0. 设计哲学(先读)

1. **给 LLM 消费,不是给渲染器消费**。输出必须是技术中立的:只出现"画布/容器/文本/图标/颜色/旋转/布局(行列/绝对定位)",不出现 div/css/flexbox/View 等任何前端词汇。具体技术栈(React/Vue/Flutter/HTML)由消费方 LLM 自己决定。
2. **视觉保真优先**:每个推断结果都要过"模拟回写验证"(见 §2.6),偏差 >2px → 降级 `absolute`。负 padding 无法用 flex 表达 → 直接放弃反写。
3. **信号分级**:原生约束(flexContainerInfo/textMode) > 类型直读(TEXT/PATH/IMAGE) > 语义命名(icon/logo/img) > 几何反推。
4. **保守输出**:交叉轴对齐推断不出唯一结论就输出 `start`,**绝不输出 stretch**(设计稿显式尺寸差异是常态,误标 stretch 会诱导错误布局)。
5. **置信度分级**:0.3(溢出/混合布局)→ 0.4(降级)→ 0.5(纯旋转)→ 0.7-0.95(flex 反推)→ 1.0(原生信号直读)。

## 1. 管线总览

```
拍平稿(扁平 sections,只有页面绝对坐标)
  │  cleanToStandardDsl
  ├── 1. 归一化:section → 节点(页面绝对坐标 + 样式信号 + 原始 DSL 透传)
  ├── 2. 分类:off-canvas / background / sticker / 容器候选
  ├── 3. 容器吸收:视觉容器(FRAME/GROUP/INSTANCE)吸收完全包含的子节点
  ├── 4. 带状聚类:y 轴聚带 → 带内 x 轴聚列
  ├── 5. 语义角色:status-bar / nav-bar / tab-bar / card / hero / section …
  ├── 6. 每容器 inferLayout 反推 flex 语义(原生信号缺失时)
  └── 7. 输出:标准 DSL 树 + 技术中立描述文本(describeStructure)
```

两条独立管线共享同一内核:
- `reconstructHierarchy`(层级重建,layout-core):任意节点树 → 语义树(带 role/bbox/layout)
- `cleanToStandardDsl`(dsl-clean):拍平稿 → 标准 DSL(与官方 flexContainerInfo 对齐)

## 2. inferLayout —— 布局反推内核(核心算法)

**输入**:容器尺寸 + 子元素相对容器的坐标(x/y/width/height/rotation)。
**输出**:`{ flexDirection, gap, padding, alignItems, justifyContent, mainSizing, crossSizing, position, confidence, absolutes }`,字段与官方 DSL 的 flexContainerInfo 对齐。

### 2.1 前置过滤
- 空子元素 → `absolute`(conf 0.4)
- **旋转节点(rotation > 0.5)永远不参与 flex 推断** → 进 `absolutes` 列表(贴纸/装饰)
- 全部旋转 → `absolute`(conf 0.5)

### 2.2 单子节点特判
- 子元素溢出容器(任一边 padding < -0.5)→ `absolute`(conf 0.3),flex 无法表达负 padding
- 水平居中(中心点偏差 ≤ 2px)→ `column + alignItems:center`,只保留垂直显式 padding
- 垂直居中 → `column + justifyContent:center`,水平位置由 padding 决定
- 否则 → `absolute`(conf 0.4)

### 2.3 行/列判定(双信号)
- 对齐信号:topAligned/leftAligned(起始边一致)、bottomAligned/rightAligned(结束边一致)、centerX/YAligned(中心点一致),容差 2px
- `rowSig = (top || centerY || bottom) && 横向展开 > 2px`
- `colSig = (left || centerX || right) && 纵向展开 > 2px`
- 双信号冲突 → 展开大的方向胜
- 两者都不成立 → 尝试网格推断(见 §2.7),失败则 `absolute` 并把每个子元素单独标记(conf 0.3)

### 2.4 主轴参数
- **gap**:主轴排序后相邻间隙数组,**众数**判定(唯一众数且出现 ≥2 次才有效;单元素数组取该值;平票/无重复 → null)
- **justifyContent**:主轴起始边对齐 = flex-start(默认);结束边对齐 = flex-end;中心对齐 = center;三者互斥
- **space-between 检测**:仅当主轴无对齐信号、≥3 子元素、存在一个明显大分隔(最大间隙 > 次大间隙 × 2.5)→ 两端分簇,簇内用众数 gap

### 2.5 padding 与 sizing
- padding = [top, right, bottom, left] = 子元素相对容器边缘的距离;任一边 < -0.5 → 降级
- mainSizing/crossSizing:内容边缘与容器边缘偏差 ≤ 2px 判 `fixed`,否则 `auto`

### 2.6 视觉保真验证(强制)
用 CSS flex 语义(相对 content box,即容器尺寸 − 两侧 padding)模拟回写每个子元素位置,逐元素与原始坐标比对,**任一偏差 > 2px → 整体降级 `absolute`**。space-between 的模拟:剩余主轴空间均分到槽位。

### 2.7 网格推断(flexWrap)
子元素沿两轴聚类后:行数 ≥2 且列数 ≥2、所有行高一致、所有列宽一致、每个 cell 恰好一个节点 → 输出 `row + wrap`(conf 0.8)。

### 2.8 交叉轴对齐(inferCrossAlign)
按优先级:中心点一致 → `center`;起始边一致 → `start`;结束边一致 → `end`;都推不出 → 保守 `start`。**绝不输出 stretch**。

### 2.9 置信度合成
基线 0.75 + gap 均匀 0.1 + center 对齐 0.05 − 双侧 padding 都不对称 0.1,上限 1.0。

## 3. 层级重建(reconstructHierarchy)

管线(提炼自 imgcook 的 Y 轴重叠分组 / Locofy 的分组递归 / Allen 区间代数):

1. **归一化**:兼容 `{x,y,width,height}` 与 `{layoutStyle:{relativeX,...}}` 两种输入
2. **off-canvas 分类**:bbox 越出画布 ±8px 的节点(floating-text 等),不参与重建
3. **background 分类**:宽 ≥ 0.8×画布宽 + (渐变/位图填充 或 blur/backdrop 效果 或 opacity<0.5)。**贴底全宽条(底距 ≤10px 且高 ≤100)不算背景** —— 它是 tab-bar 的背景条
4. **容器吸收**:FRAME/GROUP/INSTANCE 候选按面积升序;bbox 完全包含(容差 2px)且面积 < 容器 0.9 倍的子节点被吸收;无子但有阴影/填充/圆角 → 独立容器
5. **带状聚类**:全宽条(宽 ≥0.9×画布 且 高 ≤60)恒独立成带;普通节点与上一带 gap ≤12px 且上一带非全宽条 → 并入,否则新带
6. **带内 x 聚类成列**(容差 12px)
7. **角色判定**:全宽条按位置(顶 ≤30 → status-bar;底 → tab-bar;中间 → nav-bar);单节点带按视觉特征(card/hero/sticker);多节点带委托 inferLayout 判定 row/column/section
8. **TabBar 特判**:全宽背景条 + icon(高 14-40px、宽 ≤40px)与下方最近 label(x 偏差 ≤40px、y 差 ≥−4px)配对 → 合成 tab-item 容器(icon + label)
9. **递归**:每个容器再走 inferLayout

## 4. cleanToStandardDsl —— 拍平稿 → 标准 DSL

在 §3 基础上做 DSL 化的输出层:

- **叶子透传原始渲染信息**:fill/_color/effect/borderRadius/text/rowTexts/svgKey/svgShortKey/svgName/path/opacity 等全部保留(`leafToDsl` 白名单),内部子节点树原样保留
- **容器输出 flexContainerInfo**:`{ flexDirection, mainSizing, crossSizing, justifyContent?, alignItems?, gap:{row,column}?, padding:[top,right,bottom,left]? }` —— gap/padding 用结构化数字,不绑定任何框架
- **语义命名**:role 驱动(status-bar/nav-bar/learn-card/stats-row/content-tabs/tab-bar/hero + 首文本内容),如 `nav-bar-学习`,文本为空回退机器名
- **统计**:background/container/band/sticker/off-canvas 计数
- **验证契约**:清洗后树模拟渲染,每叶子页面绝对坐标与输入一致(容差 2px)

## 5. describeStructure —— 给 LLM 的结构描述

把标准 DSL 树渲染成紧凑缩进文本,**中文、技术中立**:

```
画布 375x812
容器A 317x107 @16,60 布局=column 主轴对齐=center 内边距=[16,16,16,16] [颜色:#fff | 圆角:12 | 文本:"统计"]
 容器B 285x75 @16,16 布局=row 间距=8/0 [颜色:#f5f6fa]
  文本 24x24 @0,0 [文本:"8"]
  图标 16x16 @40,6 [图标:S0#0]
```

- 每行:名称 + 尺寸 + @页面绝对坐标 + 定位方式(布局=row/column/自由定位)+ 视觉信号(颜色/填充/效果/圆角/角色/图标/文本)
- 已知缺陷:图标只输出 svgShortKey,没有 svgName 语义(如"通用/刷新")——消费方 LLM 无从知道图标是什么

## 6. classifyDsl —— 还原决策分类

每节点输出四个维度的**语义决策**(都带 confidence + reason),回答"哪些用图、哪些代码实现、哪些内容撑开、哪些绝对定位":

| 维度 | 取值 | 判定依据(信号从强到弱) |
|---|---|---|
| kind | container/text/icon/image/shape/spacer | 类型直读 > 命名语义(icon/logo/img/avatar) > 有填充判 shape > 判 spacer |
| sizing | main/cross = auto(撑开) / fixed(固定) | flexContainerInfo.mainSizing/crossSizing 直读 > textMode(auto-height/single-line) > 几何默认 |
| position | flow / absolute | rotation≠0 → absolute;父为 absolute 上下文 → absolute;否则 flow |
| spacing | gap/padding/alignItems/justifyContent | flexContainerInfo 直读 > 几何反推(inferLayout) |

- **资产清单**:inlineSvg(PATH 节点直接生成完整 `<svg>` 字符串,含 fill 解析)、images(需导出切图 + 尺寸)、texts(全部文本)
- **unresolved**:容器节点且 sizing 无信号 → 低置信度清单,供 agent 询问用户或视觉确认
- **关键裁决规则**:原生 flex 语义(flexDirection 存在)优先于几何反推的 absolute;只有拍平稿允许几何反推覆盖

## 7. 关键常数表

| 常数 | 值 | 含义 |
|---|---|---|
| TOL | 2px | 对齐/包含/回写验证容差 |
| gap 断裂 | 12px | 带状聚类并入阈值 |
| 列聚类 | 12px | 带内 x 聚类阈值 |
| 全宽条 | 宽 ≥0.9×画布 && 高 ≤60 | 恒独立成带 |
| background | 宽 ≥0.8×画布 | 背景判定下限 |
| 底部条例外 | 底距 ≤10 && 高 ≤100 | 不算背景(是 tab-bar) |
| 旋转阈值 | 0.5° | 非 0 即贴纸/绝对定位 |
| 负 padding | < -0.5px | 放弃 flex 反写 |
| space-between | 最大间隙 > 次大 × 2.5 | 分簇判定 |
| 吸收面积比 | 子 < 容器 × 0.9 | 容器吸收条件 |

## 8. 入口导出(可直接 import)

- `@3kaiu/dsh-plugin-kit`:`inferLayout` / `reconstructHierarchy` / `cleanToStandardDsl` / `describeStructure` / `clusterByAxis` / `simulateFlex` / `mode`
- `@3kaiu/dsh-layout-infer` 工具:`infer_layout`(单容器)/ `annotate_layout`(整树)/ `clean_layout`(拍平稿三段式:stats + dsl + description)/ `classify_design`(还原决策)
- 核心函数导出:`annotateNode` / `suggestName` / `classifyNode` / `kindOf` / `sizingOf` / `positionOf` / `spacingOf` / `svgOf` / `resolvePaint`

## 9. 已知边界(诚实清单)

- 图标无语义名(§5 缺陷):`describeStructure` 只给 svgShortKey,不给 svgName
- 交叉轴对齐保守:推不出就 start,不猜 stretch
- 文本语义命名依赖内容启发式(学单词/课程/直播/今日 等关键词),换领域需扩充 `bandRole`/`detectContainerRole`
- 几何反推对"原生 flex 稿"不生效:有 flexContainerInfo 就直读,不覆盖
- 大画布性能未优化:容器吸收是 O(n²) 过滤
