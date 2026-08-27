// target/merge.ts — ⑳ Merge Existing Project (V2)
// 将隔离生成的新组件合并入既有项目，隔离“还原失败”与“集成失败”
// 策略：保守合并，绝不覆盖已有业务代码；冲突时重命名或追加

import fs from 'node:fs'
import path from 'node:path'

export interface MergeOpts {
  /** 冲突策略：rename=重命名新文件, skip=跳过, overwrite=覆盖（仅显式允许） */
  onConflict?: 'rename' | 'skip' | 'overwrite'
  /** 是否更新路由/入口（默认 false，仅报告） */
  updateEntry?: boolean
}

export interface MergeResult {
  written: Array<{ path: string; action: 'created' | 'renamed' | 'skipped' | 'overwritten' }>
  conflicts: Array<{ path: string; reason: string }>
  entrySuggestion?: string
}

/**
 * 合并生成文件到目标项目
 * @param projectDir 目标项目根
 * @param files 生成文件列表 [{path, content}]，path 为相对 projectDir
 * @param opts
 */
export function mergeIntoProject(projectDir: string, files: Array<{path:string, content:string}>, opts: MergeOpts = {}): MergeResult {
  const onConflict = opts.onConflict || 'rename'
  const written: MergeResult['written'] = []
  const conflicts: MergeResult['conflicts'] = []

  for(const f of files){
    const abs = path.join(projectDir, f.path)
    const dir = path.dirname(abs)
    fs.mkdirSync(dir, { recursive: true })
    if(fs.existsSync(abs)){
      const existing = fs.readFileSync(abs, 'utf8')
      if(existing === f.content){
        written.push({ path: f.path, action: 'skipped' })
        continue
      }
      if(onConflict === 'skip'){
        conflicts.push({ path: f.path, reason: '已存在，跳过' })
        written.push({ path: f.path, action: 'skipped' })
        continue
      }
      if(onConflict === 'overwrite'){
        fs.writeFileSync(abs, f.content)
        written.push({ path: f.path, action: 'overwritten' })
        continue
      }
      // rename: 追加后缀 _restore_N
      let n=1, newPath=f.path
      let newAbs=abs
      while(fs.existsSync(newAbs)){
        const ext=path.extname(f.path), base=path.basename(f.path, ext), d=path.dirname(f.path)
        newPath = path.join(d, `${base}_restore_${n}${ext}`)
        newAbs = path.join(projectDir, newPath)
        n++
        if(n>20) break
      }
      fs.writeFileSync(newAbs, f.content)
      written.push({ path: newPath, action: 'renamed' })
      conflicts.push({ path: f.path, reason: `已存在，重命名为 ${newPath}` })
    }else{
      fs.writeFileSync(abs, f.content)
      written.push({ path: f.path, action: 'created' })
    }
  }

  // 入口建议（不自动改，仅报告）
  let entrySuggestion: string | undefined
  if(opts.updateEntry){
    entrySuggestion = `已生成 ${files.length} 个文件，请在路由/入口中手动引入：\n` + files.map(f=> `import ${path.basename(f.path, path.extname(f.path))} from './${f.path}'`).join('\n')
  }else{
    const hasEntry = fs.existsSync(path.join(projectDir, 'src/App.tsx')) || fs.existsSync(path.join(projectDir, 'src/main.tsx'))
    if(hasEntry){
      entrySuggestion = `检测到已有入口，建议手动在 src/App.tsx 中引入新组件：\nimport Restore from './${files[0]?.path || 'restore/src/Restore.tsx'}'`
    }
  }

  return { written, conflicts, entrySuggestion }
}

/**
 * 检查项目是否适合合并（预检）
 */
export function canMerge(projectDir: string): { ok: boolean; reasons: string[] }{
  const reasons:string[]=[]
  if(!fs.existsSync(path.join(projectDir, 'package.json')) && !fs.existsSync(path.join(projectDir, 'pubspec.yaml')) && !fs.existsSync(path.join(projectDir, 'app.json'))){
    reasons.push('未检测到项目标识文件(package.json/pubspec.yaml/app.json)')
  }
  return { ok: reasons.length===0, reasons }
}
