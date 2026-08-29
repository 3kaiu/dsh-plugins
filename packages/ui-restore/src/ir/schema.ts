// ir/schema.ts - BlueprintSchema v1: 描述产物的机器可校验契约
//
// 蓝图是算法对外的唯一描述产物, 消费方(LLM/代码生成器)依赖其形状稳定性。
// 本文件固化 v1 契约: JSON Schema(draft 2020-12) + 零依赖校验器。
// 规则: 新增字段必须向后兼容(可选字段); 破坏性变更升版本号。

export const BLUEPRINT_SCHEMA_VERSION = 'ui-restore/blueprint@1'

const LAYOUT_ROLES = ['row', 'column', 'stack', 'box']
const POSITIONS = ['flex', 'absolute']
const JUSTIFY = ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly']
const ALIGN = ['start', 'center', 'end', 'stretch', 'baseline']

/** JSON Schema (draft 2020-12) — 供外部校验器/IDE 提示消费 */
export function blueprintJsonSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: BLUEPRINT_SCHEMA_VERSION,
    title: 'UI Restore Blueprint',
    type: 'object',
    required: ['canvas', 'tree'],
    properties: {
      canvas: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
          // 倍率溯源(可选, 仅归一发生时存在): factor=原稿倍率, 蓝图数值已归一为逻辑像素
          scale: {
            type: 'object',
            required: ['factor', 'source'],
            properties: { factor: { type: 'number' }, source: { enum: ['explicit', 'inferred'] }, confidence: { type: 'number' } },
          },
        },
      },
      tree: { type: 'array', items: { $ref: '#/$defs/node' } },
      floatings: { type: 'array', items: { $ref: '#/$defs/node' } },
      backgrounds: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'bounds'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            // 背景 bounds 必须含完整坐标: 缺 x/y 时下游无法定位重建背景层
            bounds: { type: 'object', required: ['x', 'y', 'width', 'height'], properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
            fill: {},
          },
        },
      },
      pageShell: { type: 'object' },
      componentGroups: {
        type: 'array',
        items: {
          type: 'object',
          required: ['groupId', 'count', 'instances'],
          properties: {
            groupId: { type: 'string' },
            count: { type: 'number' },
            axis: { enum: ['row', 'column'] },
            gap: { type: 'number' },
            itemWidth: { type: 'number' },
            itemHeight: { type: 'number' },
            instances: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } } },
          },
        },
      },
      diffReport: { type: 'object' },
      truthReport: { type: 'object' },
      designTokens: { type: 'object' },
    },
    $defs: {
      node: {
        type: 'object',
        required: ['id', 'type', 'layout', 'bounds'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
          archetype: { type: 'string' },
          layout: {
            type: 'object',
            required: ['role', 'position'],
            properties: {
              role: { enum: LAYOUT_ROLES },
              position: { enum: POSITIONS },
              justifyContent: { enum: JUSTIFY },
              alignItems: { enum: ALIGN },
              gap: { oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
              // 缺省约定: justifyContent/alignItems 缺省 start; gap 缺省 0; padding 缺省全 0
              padding: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
              borderRadius: { oneOf: [{ type: 'number' }, { type: 'array' }] },
              width: { type: 'number' },
              height: { type: 'number' },
              effects: { type: 'array' },
              crossOffset: { type: 'number' },
              gapRefined: { type: 'string' },
              downgradeReason: { type: 'string' },
              // 推理溯源(算法推断元数据, 非设计稿事实): 布局置信度与判定依据
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              reason: { type: 'string' },
              // 蒙版裁剪容器: 子项越界部分渲染时被裁剪(radius 为裁剪圆角)
              clip: {
                type: 'object',
                required: ['enabled'],
                properties: { enabled: { type: 'boolean' }, source: { type: 'string' }, radius: {} },
              },
            },
          },
          bounds: {
            type: 'object',
            required: ['x', 'y', 'width', 'height'],
            properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          },
          color: { type: 'string' },
          fill: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { enum: ['solid', 'gradient', 'image'] },
              kind: { type: 'string' },
              angle: { type: 'number' },
              stops: { type: 'array', items: { type: 'object', required: ['color'], properties: { color: { type: 'string' }, position: { type: 'number' } } } },
              src: { type: 'string' },
              value: { type: 'string' },
              // 素材裁切显示: 节点 bounds 为原始素材尺寸, 仅 visibleRect(子坐标系)区域可见, 按 cover 映射
              crop: {
                type: 'object',
                required: ['mode', 'visibleRect'],
                properties: {
                  mode: { enum: ['cover'] },
                  visibleRect: {
                    type: 'object',
                    required: ['x', 'y', 'width', 'height'],
                    properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
                  },
                },
              },
            },
          },
          stroke: {
            type: 'object',
            properties: {
              color: { type: 'string' },
              width: { type: 'number' },
              align: { type: 'string' },
              style: { type: 'string' },
            },
          },
          rotation: { type: 'number' },
          opacity: { type: 'number' },
          // 蒙版本体形状: 定义父级裁剪边界, 非可见内容
          clipShape: { type: 'boolean' },
          // 合并矢量图标: 整组是一个矢量资源; 无 svgKey 时需按节点 id 从设计侧导出
          mergedVector: { type: 'boolean' },
          // 容器是裁剪显示框: 子内容真实外接盒(width/height)大于本节点 bounds, 实现以子项真实尺寸为准
          contentClipped: {
            type: 'object',
            required: ['width', 'height'],
            properties: { width: { type: 'number' }, height: { type: 'number' } },
          },
          text: { type: 'string' },
          textRuns: { type: 'array', items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, fontSize: { type: 'number' }, fontWeight: { type: 'number' }, lineHeight: { type: 'number' }, letterSpacing: { type: 'number' } } } },
          fontSize: { type: 'number' },
          fontWeight: { type: 'number' },
          lineHeight: { type: 'number' },
          letterSpacing: { type: 'number' },
          textAlign: { type: 'string' },
          fontFamily: { type: 'string' },
          softWrap: { type: 'boolean' },
          maxLines: { type: 'number' },
          measured: { type: 'object' },
          svgKey: { type: 'string' },
          svgName: { type: 'string' },
          children: { type: 'array', items: { $ref: '#/$defs/node' } },
        },
      },
    },
  }
}

/**
 * 零依赖蓝图校验器 (validateBlueprint)
 * 覆盖契约的关键不变量(枚举/数组形状/数值性/文字节点完备性),
 * 供产出侧自检与消费侧准入。返回 {ok, errors}。
 */
export function validateBlueprint(bp, opts: Record<string, any> = {}) {
  const errors = []
  const maxErrors = opts.maxErrors ?? 20
  const push = (path, msg) => { if (errors.length < maxErrors) errors.push(`${path}: ${msg}`) }
  const isNum = (v) => typeof v === 'number' && isFinite(v)

  if (!bp || typeof bp !== 'object') return { ok: false, errors: ['root: 蓝图必须是对象'] }
  if (!bp.canvas || !isNum(bp.canvas.width) || !isNum(bp.canvas.height)) push('canvas', 'width/height 必须为有限数值')
  if (!Array.isArray(bp.tree)) push('tree', '必须是数组')

  const checkNode = (n, path) => {
    if (!n || typeof n !== 'object') { push(path, '节点必须是对象'); return }
    if (typeof n.id !== 'string' || !n.id) push(path + '.id', '必须有非空字符串 id')
    const ly = n.layout
    if (!ly || typeof ly !== 'object') { push(path + '.layout', '必须有 layout'); return }
    if (!LAYOUT_ROLES.includes(ly.role)) push(path + '.layout.role', `非法 role: ${ly.role}`)
    if (ly.position && !POSITIONS.includes(ly.position)) push(path + '.layout.position', `非法 position: ${ly.position}`)
    if (ly.justifyContent && !JUSTIFY.includes(ly.justifyContent)) push(path + '.layout.justifyContent', `非法枚举: ${ly.justifyContent}`)
    if (ly.alignItems && !ALIGN.includes(ly.alignItems)) push(path + '.layout.alignItems', `非法枚举: ${ly.alignItems}`)
    if (ly.padding !== undefined && (!Array.isArray(ly.padding) || ly.padding.length !== 4 || !ly.padding.every(isNum))) push(path + '.layout.padding', '必须是 4 元数值数组 [top,right,bottom,left](缺省=全 0 可省略)')
    if (ly.gap !== undefined && typeof ly.gap !== 'number' && !Array.isArray(ly.gap)) push(path + '.layout.gap', '必须是数值或数值数组')
    if (ly.confidence !== undefined && (!isNum(ly.confidence) || ly.confidence < 0 || ly.confidence > 1)) push(path + '.layout.confidence', '必须是 0~1 的有限数值')
    if (ly.reason !== undefined && typeof ly.reason !== 'string') push(path + '.layout.reason', '必须是字符串')
    if (ly.clip !== undefined && (!ly.clip || typeof ly.clip !== 'object' || typeof ly.clip.enabled !== 'boolean')) push(path + '.layout.clip', '必须为 {enabled:boolean, source?, radius?}')
    if (n.clipShape !== undefined && typeof n.clipShape !== 'boolean') push(path + '.clipShape', '必须是布尔')
    if (n.mergedVector !== undefined && typeof n.mergedVector !== 'boolean') push(path + '.mergedVector', '必须是布尔')
    if (n.contentClipped !== undefined) {
      const cc = n.contentClipped
      if (!cc || !isNum(cc.width) || !isNum(cc.height)) push(path + '.contentClipped', '必须为 {width:number, height:number}(内容真实外接盒)')
    }
    if (n.fill?.crop !== undefined) {
      const cr = n.fill.crop
      const vr = cr?.visibleRect
      if (cr?.mode !== 'cover' || !vr || !isNum(vr.x) || !isNum(vr.y) || !isNum(vr.width) || !isNum(vr.height)) {
        push(path + '.fill.crop', '必须为 {mode:"cover", visibleRect:{x,y,width,height}}')
      }
    }
    const b = n.bounds
    if (!b || !isNum(b.x) || !isNum(b.y) || !isNum(b.width) || !isNum(b.height)) push(path + '.bounds', 'x/y/width/height 必须为有限数值')
    else if (b.width <= 0 || b.height <= 0) push(path + '.bounds', 'width/height 必须为正数(非占位/非退化)')
    if (n.type === 'TEXT' && typeof n.text !== 'string') push(path + '.text', 'TEXT 节点必须有字符串 text')
    for (const c of Array.isArray(n.children) ? n.children : []) checkNode(c, path + '/' + (c.id ?? '?'))
  }
  for (const r of Array.isArray(bp.tree) ? bp.tree : []) checkNode(r, 'tree/' + (r.id ?? '?'))
  for (const r of Array.isArray(bp.floatings) ? bp.floatings : []) checkNode(r, 'floatings/' + (r.id ?? '?'))

  // backgrounds 单独输出的层也要过契约(id + 完整坐标 bounds; 无坐标则下游无法重建)
  for (const [i, bg] of (Array.isArray(bp.backgrounds) ? bp.backgrounds : []).entries()) {
    const p = `backgrounds/${i}`
    if (!bg || typeof bg !== 'object') { push(p, '必须是对象'); continue }
    if (typeof bg.id !== 'string' || !bg.id) push(p + '.id', '必须有非空字符串 id')
    const bb = bg.bounds
    if (!bb || !isNum(bb.x) || !isNum(bb.y) || !isNum(bb.width) || !isNum(bb.height)) push(p + '.bounds', 'x/y/width/height 必须为有限数值')
    else if (bb.width <= 0 || bb.height <= 0) push(p + '.bounds', 'width/height 必须为正数')
  }

  return { ok: errors.length === 0, errors }
}
