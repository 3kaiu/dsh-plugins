// 路径收容守卫：MCP 工具的参数路径（读/写）解析后必须落在收容根内。
// 防 ../ 逃逸与任意文件读写（2026-08 前守卫函数已定义但从未接线）。
// 收容根默认 = MCP server 启动目录（项目根）；UI_RESTORE_ROOT 环境变量可显式放宽。
import path from 'node:path';

export function guardRoot() {
  return process.env.UI_RESTORE_ROOT || process.cwd();
}

/** 把 rel 解析进 rootDir；逃逸即抛错（fail loud）。 */
export function confineTo(rootDir, rel) {
  const abs = path.resolve(rootDir, rel);
  const rel2 = path.relative(rootDir, abs);
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) throw new Error(`拒绝越界路径: ${rel}`);
  return abs;
}

/** 同 confineTo 的宽容变体：逃逸（含 rel 解析为根本身）返回 null 而非抛错。
 *  收敛自 target/asset-resolver.ts 的本地 confine —— 资产解析对越界的正确处置是拒绝该项，不是中断整批。 */
export function confineOrNull(rootDir, rel) {
  const abs = path.resolve(rootDir, rel);
  const rel2 = path.relative(rootDir, abs);
  if (rel2 === '' || rel2.startsWith('..') || path.isAbsolute(rel2)) return null;
  return abs;
}

/** 按收容根实例化一个单参守卫（工具 handler 内统一用它包路径参数）。 */
export function makeGuard({ root } = {}) {
  const ROOT = root || guardRoot();
  return {
    ROOT,
    confineUnder: (rel) => confineTo(ROOT, rel),
  };
}
