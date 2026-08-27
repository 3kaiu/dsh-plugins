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

export function unregisterAdapter(id:string){
  _registry.delete(id)
}

/**
 * 按 profile + 显式 serializer 解析适配器
 * 优先级：显式 serializer > framework 精确匹配 > styling 匹配 > 默认 react
 */
export function resolveAdapter(profile:any, explicit?: string): EmitterAdapter {
  if(explicit && _registry.has(explicit)) return _registry.get(explicit)!
  if(explicit) throw new Error(`未知 serializer: ${explicit}，可用: ${[..._registry.keys()].join(', ')}`)
  const fw = profile?.framework
  const styling = profile?.styling
  // 优先级：styling 精确匹配 > framework 精确匹配 > 默认 react
  // 保证 React+Tailwind 项目优先走 tailwind 适配器，而非 react
  if(styling){
    const hit = [..._registry.values()].find(a=> a.styling===styling)
    if(hit) return hit
  }
  if(fw){
    const hit = [..._registry.values()].find(a=> a.framework===fw)
    if(hit) return hit
  }
  // 默认 react
  return _registry.get('react') || [..._registry.values()][0]
}

import { emitReact } from './react.ts'
import { emitVue } from './vue.ts'
import { emitFlutter } from './flutter.ts'
import { emitMiniProgram } from './miniprogram.ts'
import { emitTailwindReact } from './tailwind.ts'

// 内置适配器即时注册（核心内聚，适配器热插拔：外部可后续 registerAdapter 覆盖或新增）
registerAdapter({ id:'react', framework:'react', description:'React inline 样式（默认）', emit: emitReact })
registerAdapter({ id:'vue', framework:'vue', description:'Vue 3 SFC', emit: emitVue })
registerAdapter({ id:'flutter', framework:'flutter', description:'Flutter Widget', emit: emitFlutter })
registerAdapter({ id:'miniprogram', framework:'miniprogram', description:'小程序 WXML/WXSS', emit: emitMiniProgram })
registerAdapter({ id:'tailwind', styling:'tailwind', description:'React + Tailwind 任意值', emit: emitTailwindReact })
// html 预览不参与 framework 选择，单独由调用方直接 import emitPreviewHtml

// 兼容旧调用：ensureBuiltins 已改为 no-op（内置已即时注册）
let _initialized = true
export async function ensureBuiltins(){ return }
