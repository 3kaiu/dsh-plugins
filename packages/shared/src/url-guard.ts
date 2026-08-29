'use strict'
// url-guard — 渲染/导航目标 URL 防护正典(doc19 backlog: SSRF 加固, 2026-08-29)
//
// 收敛背景: ui-restore browser-launch.toUrl 的原防护只做主机名黑名单
// (localhost/127.*/169.254.*), 可被以下形态绕过:
//   十进制 IP http://2130706433 (=127.0.0.1)、八进制 0177.0.0.1、十六进制 0x7f000001、
//   短式 127.1、IPv6-mapped [::ffff:127.0.0.1]; 且 10/8、172.16/12、192.168/16、
//   fc00::/7 等 RFC1918/ULA 内网段完全未挡; ura 的 browser_navigate 更是零校验。
// 正确做法(本模块): 统一经 getaddrinfo 解析 —— 十进制/八进制/十六进制/短式 IP
// 字面量与域名走同一条路归一 —— 对解析出的【每个】地址做全保留段校验;
// 解析失败 fail closed。注意: 这只校验"解析时刻"的地址, 浏览器随后自行
// 解析仍有 TOCTOU 窗口(DNS rebinding), 对 LLM 可传 URL 的高危场景应配合网络侧隔离。
//
// 逃生阀: 环境变量 UI_RESTORE_ALLOW_PRIVATE_URLS=1 跳过内网校验
// (本地 dev server / 内网预览等受信场景)。
import dns from 'node:dns'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const ALLOW_PRIVATE = () => process.env.UI_RESTORE_ALLOW_PRIVATE_URLS === '1'

/** IPv6 字面量 → 8 组 16bit 整数(展开 :: 与点分 v4 尾部); 非法返回 null */
function expandV6(low) {
  const dc = low.indexOf('::')
  const headStr = dc >= 0 ? low.slice(0, dc) : low
  let tailStr = dc >= 0 ? low.slice(dc + 2) : ''
  if (!dc && low === '::') tailStr = ''
  const head = headStr ? headStr.split(':') : []
  let tail = tailStr ? tailStr.split(':') : []
  let dotted = []
  if (tail.length && tail[tail.length - 1].includes('.')) {
    const seg = tail.pop().split('.').map(Number)
    if (seg.length !== 4 || seg.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    dotted = [((seg[0] << 8) | seg[1]).toString(16), ((seg[2] << 8) | seg[3]).toString(16)]
  }
  const groups = [...head, ...tail, ...dotted]
  if (dc < 0 && groups.length !== 8) return null
  if (groups.length > 8) return null
  while (groups.length < 8) groups.splice(head.length, 0, '0')
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : -1))
  return nums.some((n) => n < 0) ? null : nums
}

/** IPv4/IPv6 是否落在保留/内网段(loopback/私网/link-local/CGNAT/组播/未指定) */
export function isReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||                              // 未指定/私网/loopback
      (a === 100 && b >= 64 && b <= 127) ||                            // CGNAT 100.64/10
      (a === 169 && b === 254) ||                                      // link-local(含云元数据 169.254.169.254)
      (a === 172 && b >= 16 && b <= 31) ||                             // 私网
      (a === 192 && (b === 0 || b === 168)) ||                         // 协议分配 192.0.0/24,192.0.2/24 + 私网
      (a === 198 && (b === 18 || b === 19)) ||                         // 基准测试 198.18/15
      a >= 224                                                         // 组播 224/4 + 保留 240/4 + 广播
    )
  }
  if (net.isIPv6(ip)) {
    const bytes = expandV6(ip.toLowerCase())
    if (!bytes) return true                                            // 无法解析的形态 fail closed
    // v4-mapped/compatible (::ffff:0:0/96, 点分与十六进制两种形态) → 校验内嵌 v4
    if (bytes.slice(0, 5).every((n) => n === 0) && (bytes[5] === 0xffff || bytes[5] === 0)) {
      if (bytes[5] === 0xffff) return isReservedIp(`${bytes[6] >> 8}.${bytes[6] & 255}.${bytes[7] >> 8}.${bytes[7] & 255}`)
      // ::/96 兼容段(历史形态) → 内嵌 v4 同样校验
      if (bytes.slice(6, 8).some((n) => n !== 0)) return isReservedIp(`${bytes[6] >> 8}.${bytes[6] & 255}.${bytes[7] >> 8}.${bytes[7] & 255}`)
      return true                                                      // :: 未指定
    }
    if (bytes.slice(0, 7).every((n) => n === 0) && bytes[7] === 1) return true // ::1 loopback
    const first = bytes[0] >> 8
    if (first === 0xfc || first === 0xfd) return true                  // fc00::/7 unique-local
    if (first === 0xfe && (bytes[0] & 255) >= 0x80 && (bytes[0] & 255) <= 0xbf) return true // fe80::/10 link-local
    if (first === 0xff) return true                                    // 组播
    return false
  }
  return true                                                          // 未知形态 fail closed
}

/**
 * 校验并归一 http(s) 目标; 内网/保留段/凭据/解析失败一律 throw(fail closed)。
 * 返回归一化 href。IP 字面量的解析在本地 getaddrinfo 完成, 不依赖网络。
 */
export async function assertPublicHttpUrl(raw) {
  let u
  try { u = new URL(String(raw)) } catch { throw new Error(`非法 URL: ${raw}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`仅允许 http/https, 收到 ${u.protocol}`)
  if (u.username || u.password) throw new Error('拒绝携带凭据的 URL(userinfo)')
  if (ALLOW_PRIVATE()) return u.href
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error(`拒绝访问内网/元数据地址: ${host}`)
  }
  const bare = host.replace(/^\[/, '').replace(/\]$/, '')              // URL.hostname 对 IPv6 保留方括号
  let addrs
  try { addrs = await dns.promises.lookup(bare, { all: true, verbatim: true }) }
  catch { throw new Error(`目标主机解析失败(fail closed): ${host}`) }
  const bad = addrs.find((a) => isReservedIp(a.address))
  if (bad) throw new Error(`拒绝访问内网/保留地址: ${host} → ${bad.address}`)
  return u.href
}

/** file:// 渲染目标: 本地产物渲染合法, 但拒绝敏感系统路径(LFI) */
export function safeFileUrl(raw) {
  const abs = path.resolve(String(raw).replace(/^file:\/\//, ''))
  const SENSITIVE = ['/etc/', '/proc/', '/sys/', '/root/', '/private/etc/', '/windows/system32/']
  const lower = abs.toLowerCase()
  if (SENSITIVE.some((p) => lower.startsWith(p)) || lower.includes('/.ssh/') || lower.includes('\\.ssh\\')) {
    throw new Error(`拒绝访问敏感系统路径: ${raw}`)
  }
  if (!fs.existsSync(abs)) throw new Error(`目标不存在: ${abs}`)
  return `file://${abs}`
}

/** 渲染/导航目标统一入口: http(s) 走 DNS 级校验, 本地路径走 LFI 校验(异步) */
export async function resolveRenderTarget(raw) {
  const s = String(raw)
  if (/^https?:\/\//i.test(s)) return assertPublicHttpUrl(s)
  return safeFileUrl(s)
}
