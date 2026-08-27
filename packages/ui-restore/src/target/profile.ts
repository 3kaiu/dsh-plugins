// target/profile.ts — Target Profile 存取(落盘/读取/校验)
//
// profile.json 是 Resolver 决策的持久化形态: generate 前生成一次,
// 修复循环只读不改(改技术栈 = 新一轮 generate, 不许在 Repair 里偷改)。
import fs from 'node:fs'
import path from 'node:path'

/** 保存 profile( pretty JSON)并返回写入路径 */
export function saveProfile(profile, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 1))
  return filePath
}

/** 读取 profile; 缺字段时以 unknown/默认补齐并标注 (兼容手写 profile) */
export function loadProfile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const p = {
    framework: raw.framework ?? 'unknown',
    language: raw.language ?? 'unknown',
    styling: raw.styling ?? 'unknown',
    build: raw.build ?? 'none',
    componentLibraries: Array.isArray(raw.componentLibraries) ? raw.componentLibraries : [],
    fonts: {
      fallbackStack: Array.isArray(raw.fonts?.fallbackStack) && raw.fonts.fallbackStack.length
        ? raw.fonts.fallbackStack
        : ['PingFang SC', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
      webFonts: Array.isArray(raw.fonts?.webFonts) ? raw.fonts.webFonts : [],
    },
    assetDir: raw.assetDir ?? 'src/assets',
    decisions: raw.decisions ?? {},
  }
  return p
}
