// fs-util — JSON/文本读取单一来源(收敛自 pipeline/detect/mcp 三份各自为政的拷贝)
//
// 层规则(2026-08-29 收敛时定型): 路径收容(防 ../ 越界)是【入口适配器】对不可信路径参数的
// 职责 —— MCP 工具参数在 mcp-server.ts 经 confineUnder 收容后才落库层; CLI 由可信用户自担。
// 库层(pipeline/detect)不做收容: benchmark/脚本会传 /tmp 等收容根外绝对路径,
// 在库层收容会直接打断合法用法。守卫实现见 path-guard.ts。
import fs from 'node:fs'

/** 严格读 JSON: 缺文件/坏 JSON 直接 throw(调用方决定报错语义)。MCP 入口用它包一层 confineUnder。 */
export const readJsonStrict = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

/** 宽容读 JSON: 任何失败(缺文件/坏 JSON)返回 null。用于探测式扫描(detect.ts)。 */
export const readJsonTolerant = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

/** 宽容读文本: 失败返回空串。 */
export const readTextTolerant = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
