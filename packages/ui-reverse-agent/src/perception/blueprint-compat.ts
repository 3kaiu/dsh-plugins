// blueprint-compat: core 蓝图 → 消费面兼容词汇派生层
// core generateCodeBlueprint 产物 {canvas,tree,floatings,backgrounds,...} 为正典；
// kit 弱轨 buildBlueprint 已退役，本模块派生的 regions/assets/palette/typographyProfile/viewports/states/meta
// 是蓝图对外消费的兼容投影，不改动任何 core 数值 —— 数值一律直读节点 bounds/样式，禁止取整与臆测。

type Any = Record<string, any>;

const PRIORITY_ROLE_RE = {
  P0: /header|nav|status|tab-bar|grid-row|card-deck|card|section|main|sidebar/i,
  P2: /icon|decoration/i,
} as const;

function rolePriority(role: string): string {
  if (PRIORITY_ROLE_RE.P0.test(role)) return 'P0';
  if (PRIORITY_ROLE_RE.P2.test(role)) return 'P2';
  return 'P1';
}

/** 遍历蓝图的 tree + floatings（backgrounds 不参与节点级派生，由调用方单独处理） */
function walkBlueprintNodes(bp: Any, fn: (node: Any, path: string) => void): void {
  const walk = (nodes: any, parentPath: string): void => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const p = parentPath ? `${parentPath} > ${n.name || n.id}` : String(n.name || n.id || '');
      fn(n, p);
      if (Array.isArray(n.children)) walk(n.children, p);
    }
  };
  walk(Array.isArray(bp?.tree) ? bp.tree : [], '');
  const fl = Array.isArray(bp?.floatings) ? bp.floatings : [];
  for (const f of fl) {
    if (!f || typeof f !== 'object') continue;
    fn(f, `floating > ${f.name || f.id}`);
    if (Array.isArray(f.children)) walk(f.children, `floating > ${f.name || f.id}`);
  }
}

/**
 * regions：page_shell 等合成根不产 region（全屏兜底无信息量）；
 * 唯一根为合成组时取其 children 作为顶层区域，否则取顶层。
 */
export function deriveRegions(bp: Any): Any[] {
  let roots: Any[] = Array.isArray(bp?.tree) ? bp.tree : [];
  if (roots.length === 1 && roots[0]?.isSyntheticGroup && Array.isArray(roots[0].children) && roots[0].children.length > 0) {
    roots = roots[0].children;
  }
  return roots.map((n: Any) => {
    const name = String(n.name || n.id || 'region');
    const role = String(n.layout?.role || name);
    const b = n.bounds || {};
    return {
      id: n.id,
      name,
      role,
      priority: rolePriority(role),
      bbox: { x: b.x ?? 0, y: b.y ?? 0, width: b.width ?? 0, height: b.height ?? 0 },
    };
  });
}

/** assets：icons(svgKey/svgShortKey) + images(image fill) + fonts + texts，词表与 kit 蓝图同构 */
export function deriveAssets(bp: Any): Any {
  const images: Any[] = [];
  const icons: Any[] = [];
  const fonts = new Set<string>();
  const texts: string[] = [];
  walkBlueprintNodes(bp, (n: Any) => {
    const text = typeof n.text === 'string' ? n.text : '';
    if (text) texts.push(text);
    const svgRef = n.svgKey || n.svgShortKey;
    if (svgRef) icons.push({ id: n.id, key: svgRef, name: n.svgName || n.name || '', svg: typeof n.svg === 'string' ? n.svg : undefined });
    const family = n.fontFamily || n.computed?.fontFamily || n.font?.family;
    if (typeof family === 'string' && family) fonts.add(family);
    const fill = n.fill;
    const fillStr = typeof fill === 'string' ? fill : null;
    const isImage = (fill && typeof fill === 'object' && fill.type === 'image') || (fillStr && (/^url\(/i.test(fillStr) || /^https?:\/\/\S+$/i.test(fillStr)));
    if (isImage) images.push({ id: n.id, src: (fill && typeof fill === 'object' ? fill.src : fillStr) || '' });
  });
  return { images, icons, fonts: [...fonts], texts: [...new Set(texts.filter(Boolean))].slice(0, 200) };
}

/** palette：节点 color/fill/gradient stops + backgrounds 填充 + styles 表字符串值，'#' 开头频次 top12；styles 表由调用方传入（core 蓝图本体不携带，ingest 产物才有） */
export function derivePalette(bp: Any, stylesTable?: Any | null): Any[] {
  const colors: string[] = [];
  const pushColor = (v: any): void => {
    if (typeof v === 'string' && v.startsWith('#')) colors.push(v.toLowerCase());
  };
  walkBlueprintNodes(bp, (n: Any) => {
    pushColor(n.color);
    pushColor(n._color);
    pushColor(n.textColor);
    const fill = n.fill;
    if (typeof fill === 'string') pushColor(fill);
    else if (fill && typeof fill === 'object' && Array.isArray(fill.stops)) {
      for (const s of fill.stops) pushColor(s?.color);
    }
  });
  for (const bg of Array.isArray(bp?.backgrounds) ? bp.backgrounds : []) {
    if (!bg || typeof bg !== 'object') continue;
    pushColor(bg.fill);
    pushColor(bg._color);
    pushColor(bg.color);
  }
  const table = stylesTable && typeof stylesTable === 'object' ? stylesTable : null;
  if (table) {
    for (const v of Object.values(table)) {
      if (typeof v === 'string') pushColor(v);
      else if (v && typeof v === 'object') {
        pushColor(v.value);
        const val = v.value;
        if (val && typeof val === 'object' && Array.isArray(val.stops)) {
          for (const s of val.stops) pushColor(s?.color);
        }
      }
    }
  }
  const freq = new Map<string, number>();
  for (const c of colors) freq.set(c, (freq.get(c) || 0) + 1);
  return [...freq.entries()].sort((a: [string, number], b: [string, number]) => b[1] - a[1]).slice(0, 12).map(([hex, count]) => ({ hex, count }));
}

/** typographyProfile：文本节点按树路径归档排版事实（family/size/weight/lineHeight/letterSpacing/color + 文本样本） */
export function deriveTypographyProfile(bp: Any): Record<string, Any> {
  const profile: Record<string, Any> = {};
  walkBlueprintNodes(bp, (n: Any, path: string) => {
    const text = typeof n.text === 'string' ? n.text.trim() : '';
    if (!text) return;
    profile[path || String(n.id)] = {
      family: n.fontFamily ?? null,
      size: n.fontSize ?? null,
      weight: n.fontWeight ?? null,
      lineHeight: n.lineHeight ?? null,
      letterSpacing: n.letterSpacing ?? null,
      color: n.color ?? n.fill ?? null,
      sample: text.slice(0, 48),
    };
  });
  return profile;
}

/**
 * 把 kit 兼容词汇附加到 core 蓝图（就地 mutate）。
 * opts.source: 'dsl' | 'url' | 'screenshot'；opts.metaExtras 并入 blueprint.meta。
 */
export function deriveCompatFields(bp: Any, opts: { source: string; viewport?: Any | null; lint?: Any | null; gates?: Any | null; styles?: Any | null; metaExtras?: Any | null } = { source: 'unknown' }): { regions: Any[]; assets: Any } {
  bp.regions = deriveRegions(bp);
  bp.assets = deriveAssets(bp);
  bp.palette = derivePalette(bp, opts.styles ?? null);
  bp.typographyProfile = deriveTypographyProfile(bp);
  bp.viewports = opts.viewport ? [opts.viewport] : [{ name: 'desktop', width: bp.canvas?.width ?? 0, height: bp.canvas?.height ?? 0 }];
  bp.states = ['default'];
  bp.meta = {
    createdAt: new Date().toISOString(),
    source: opts.source,
    ...(opts.lint ? { lint: opts.lint } : {}),
    ...(opts.gates ? { gates: opts.gates } : {}),
    ...(opts.metaExtras || {}),
  };
  return { regions: bp.regions as Any[], assets: bp.assets as Any };
}
