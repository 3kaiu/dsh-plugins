// emit/registry.ts — 热插拔适配器注册表
// 核心仅依赖 Style IR，适配器通过 registerAdapter 热插拔，无需改核心
// 新栈只需：import { registerAdapter } from '@ui-restore/core/emit/registry'; registerAdapter(myAdapter)

export interface EmitterAdapter {
  /** 唯一 id，如 react / vue / flutter / miniprogram / tailwind / html */
  id: string
  /** 匹配的 framework，如 vue / flutter / miniprogram / react；styling 适配器可不填 framework */
  framework?: string
  /** 匹配的 styling，如 tailwind */
  styling?: string
  /** 优先级，数值越大越优先（显式 serializer 最高） */
  priority?: number
  /** 发射函数：与现有 emit* 同签名 */
  emit: (bp:any, plan:any, assets:any, profile:any, opts?:any)=>{ files: Array<{path:string,content:string}>, map:any, [k:string]:any }
  /** 描述 */
  description?: string
}

const _registry = new Map<string, EmitterAdapter>()

// 内置适配器按需懒加载：核心不静态依赖任何适配器，首次 resolve 时才动态 import
// 保证 Flutter 项目不加载 React/Vue 代码，符合“按需热插拔”与“无用耦合最小化”
const BUILTINS: Record<string, () => Promise<EmitterAdapter>> = {
  react: async () => { const { emitReact } = await import('./react.ts'); return { id:'react', framework:'react', description:'React inline 样式（默认）', emit: emitReact } },
  inline: async () => { const { emitReact } = await import('./react.ts'); return { id:'inline', framework:'react', description:'React inline 样式（react 别名）', emit: emitReact } },
  vue: async () => { const { emitVue } = await import('./vue.ts'); return { id:'vue', framework:'vue', description:'Vue 3 SFC', emit: emitVue } },
  flutter: async () => { const { emitFlutter } = await import('./flutter.ts'); return { id:'flutter', framework:'flutter', description:'Flutter Widget', emit: emitFlutter } },
  miniprogram: async () => { const { emitMiniProgram } = await import('./miniprogram.ts'); return { id:'miniprogram', framework:'miniprogram', description:'小程序 WXML/WXSS', emit: emitMiniProgram } },
  tailwind: async () => { const { emitTailwindReact } = await import('./tailwind.ts'); return { id:'tailwind', styling:'tailwind', description:'React + Tailwind 任意值', emit: emitTailwindReact } },
  unocss: async () => { const { emitTailwindReact } = await import('./tailwind.ts'); return { id:'unocss', styling:'unocss', description:'UnoCSS (Tailwind 兼容)', emit: emitTailwindReact } },
  html: async () => { const { emitPreviewHtml } = await import('./html.ts'); return { id:'html', description:'预览用 HTML（inline 样式）', emit: emitPreviewHtml } },
}

// framework 别名：next 实为 react 生态，统一映射到 react 适配器，避免 silent 误解析
const FRAMEWORK_ALIASES: Record<string, string> = { next: 'react', 'react-dom': 'react' }
// 已知但本插件无适配器的 framework：出现时明确报错，不再静默退化为 React
const UNSUPPORTED_FRAMEWORKS = new Set(['svelte', 'solid-js', 'solid', 'angular', 'ember', 'riot', 'preact'])

export function registerAdapter(adapter: EmitterAdapter){
  if(!adapter || !adapter.id || typeof adapter.emit!=='function') throw new Error('registerAdapter: 非法适配器')
  _registry.set(adapter.id, adapter)
}

export function getAdapter(id:string): EmitterAdapter | undefined {
  return _registry.get(id)
}

export function listAdapters(): EmitterAdapter[] {
  return [..._registry.values()]
}
export function listAvailableAdapterIds(): string[] {
  // 已注册 + 内置未加载的 id 合并，保 CLI/MCP 帮助信息完整（热插拔未加载时亦可见）
  return [...new Set([..._registry.keys(), ...Object.keys(BUILTINS)])]
}
export function getAvailableAdapterIds(): string[] { return listAvailableAdapterIds() }

export function unregisterAdapter(id:string){
  _registry.delete(id)
}

function normalizeFramework(fw?: string): string {
  if (!fw) return 'unknown'
  return FRAMEWORK_ALIASES[fw] || fw
}

/** 加载内置适配器,失败时给出可读错误(避免底层模块错误透传为不透明崩溃) */
async function loadBuiltin(id: string): Promise<EmitterAdapter> {
  const loader = BUILTINS[id]
  if (!loader) throw new Error(`未知适配器: ${id}`)
  try {
    return await loader()
  } catch (e) {
    throw new Error(`加载适配器 "${id}" 失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 按 profile + 显式 serializer 解析适配器（同步，仅查已注册）
 * 优先级：显式 serializer > framework 精确匹配 > styling 匹配 > 默认 react
 */
export function resolveAdapter(profile:any, explicit?: string): EmitterAdapter {
  if(explicit && _registry.has(explicit)) return _registry.get(explicit)!
  if(explicit) throw new Error(`未知 serializer: ${explicit}，可用: ${[..._registry.keys()].join(', ')}`)
  const fw = normalizeFramework(profile?.framework)
  const styling = profile?.styling
  if(styling){
    const hit = [..._registry.values()].find(a=> a.styling===styling)
    if(hit) return hit
  }
  if(fw && fw !== 'unknown'){
    const hit = [..._registry.values()].find(a=> a.framework===fw)
    if(hit) return hit
  }
  return _registry.get('react') || [..._registry.values()][0]
}

/**
 * 异步解析（热插拔按需加载）：未注册时动态 import 对应适配器模块
 * 核心仅在需要时才加载对应适配器代码，Flutter 项目不加载 React/Vue
 */
export async function resolveAdapterAsync(profile:any, explicit?: string): Promise<EmitterAdapter> {
  if(explicit){
    const key = explicit === 'inline' ? 'react' : explicit
    if(_registry.has(key)) return _registry.get(key)!
    // 按需加载显式指定的适配器
    if(BUILTINS[key]){
      const a = await loadBuiltin(key)
      registerAdapter(a)
      return a
    }
    throw new Error(`未知 serializer: ${explicit}，可用: ${Object.keys(BUILTINS).join(', ')}`)
  }
  const fw = normalizeFramework(profile?.framework)
  const styling = profile?.styling
  // styling 优先
  if(styling && BUILTINS[styling] && !_registry.has(styling)){
    const a = await loadBuiltin(styling)
    registerAdapter(a)
  }
  if(styling){
    const hit = [..._registry.values()].find(a=> a.styling===styling)
    if(hit) return hit
  }
  if(fw && fw !== 'unknown' && BUILTINS[fw] && !_registry.has(fw)){
    const a = await loadBuiltin(fw)
    registerAdapter(a)
  }
  if(fw && fw !== 'unknown'){
    const hit = [..._registry.values()].find(a=> a.framework===fw)
    if(hit) return hit
  }
  // 显式 framework 无适配器 → 不再静默退化 React，明确报错要求用户指定
  if(fw && fw !== 'unknown'){
    throw new Error(`无法确定目标技术栈：探测到 framework="${fw}" 但无对应适配器。请显式传 --serializer（可选: ${Object.keys(BUILTINS).join(', ')}）`)
  }
  if(!_registry.has('react')){
    const a = await loadBuiltin('react')
    registerAdapter(a)
  }
  return _registry.get('react')!
}

let _initialized = false
export async function ensureBuiltins(){
  if(_initialized) return
  const react = await BUILTINS.react()
  registerAdapter(react)
  _initialized = true
}
export async function ensureAdapter(id:string){
  if(_registry.has(id)) return _registry.get(id)!
  const loader = BUILTINS[id]
  if(!loader) throw new Error(`未知适配器: ${id}`)
  const adapter = await loader()
  registerAdapter(adapter)
  return adapter
}
