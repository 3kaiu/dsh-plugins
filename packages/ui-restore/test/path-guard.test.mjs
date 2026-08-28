// path-guard 单测：MCP 工具参数路径的收容语义（../ 逃逸 / 绝对路径越界 / 根内解析）。
import { confineTo, makeGuard, guardRoot } from "../adapters/path-guard.mjs";
import path from 'node:path';
import os from 'node:os';

const root = path.join(os.tmpdir(), 'dsh-guard-root');

// 1) 根内相对路径 → 解析为根内绝对路径
const inside = confineTo(root, 'sub/dir/file.json');
if (inside !== path.join(root, 'sub/dir/file.json')) throw new Error('根内路径解析错误');
console.log('✓ 根内相对路径解析');

// 2) ../ 逃逸 → 拒绝
let threw = false;
try { confineTo(root, '../outside.json'); } catch (e) { threw = /拒绝越界路径/.test(String(e)); }
if (!threw) throw new Error('../ 逃逸未被拒绝');
console.log('✓ ../ 逃逸拒绝');

// 3) 越界绝对路径 → 拒绝
threw = false;
try { confineTo(root, path.join(os.tmpdir(), 'elsewhere/x.json')); } catch (e) { threw = /拒绝越界路径/.test(String(e)); }
if (!threw) throw new Error('绝对路径越界未被拒绝');
console.log('✓ 绝对路径越界拒绝');

// 4) 根内绝对路径 → 放行（工具可能回传此前已收容的绝对路径）
const again = confineTo(root, inside);
if (again !== inside) throw new Error('根内绝对路径应放行');
console.log('✓ 根内绝对路径放行');

// 5) makeGuard 单参守卫 + 自定义根
const g = makeGuard({ root });
if (g.confineUnder('a') !== path.join(root, 'a')) throw new Error('makeGuard 根不符');
let gThrew = false;
try { g.confineUnder('..'); } catch { gThrew = true; }
if (!gThrew) throw new Error('makeGuard 守卫未生效');
console.log('✓ makeGuard 单参守卫');

// 6) 默认根 = cwd（不依赖 UI_RESTORE_ROOT 时）
if (guardRoot() !== process.cwd()) throw new Error('默认收容根应为 cwd');
console.log('✓ 默认收容根 cwd');

console.log('path-guard OK ✓');
