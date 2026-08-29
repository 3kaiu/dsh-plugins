// url-guard 回归: SSRF 绕过形态必须全部拦截(黑名单时代的已知逃逸), 合法目标放行。
// 全部用 IP 字面量/本地文件 —— getaddrinfo 对字面量在本地归一, 测试不依赖网络 DNS。
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPublicHttpUrl, safeFileUrl, resolveRenderTarget, isReservedIp } from "@3kaiu/dsh-plugin-kit";

let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log(`✓ ${label}`); };
const rejects = async (label, fn) => {
  try { await fn(); fail++; console.log(`✗ ${label}(未拒绝)`); }
  catch { ok(label); }
};
const accepts = async (label, fn) => {
  try { await fn(); ok(label); }
  catch (e) { fail++; console.log(`✗ ${label}: ${e.message}`); }
};

// ---- 1. 黑名单时代的绕过形态(全部必须拒绝) ----
await rejects("十进制 IP http://2130706433 → 127.0.0.1", () => assertPublicHttpUrl("http://2130706433/"));
await rejects("八进制 IP http://0177.0.0.1", () => assertPublicHttpUrl("http://0177.0.0.1/"));
await rejects("十六进制 IP http://0x7f000001", () => assertPublicHttpUrl("http://0x7f000001/"));
await rejects("短式 IP http://127.1", () => assertPublicHttpUrl("http://127.1/"));
await rejects("IPv6-mapped http://[::ffff:127.0.0.1]", () => assertPublicHttpUrl("http://[::ffff:127.0.0.1]/"));
await rejects("IPv6 loopback http://[::1]", () => assertPublicHttpUrl("http://[::1]/"));
await rejects("RFC1918 10/8", () => assertPublicHttpUrl("http://10.0.0.1/"));
await rejects("RFC1918 172.16/12", () => assertPublicHttpUrl("http://172.16.0.1/"));
await rejects("RFC1918 192.168/16", () => assertPublicHttpUrl("http://192.168.1.1/"));
await rejects("云元数据 169.254.169.254", () => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"));
await rejects("CGNAT 100.64/10", () => assertPublicHttpUrl("http://100.64.0.1/"));
await rejects("ULA fc00::/7", () => assertPublicHttpUrl("http://[fc00::1]/"));
await rejects("link-local fe80::/10", () => assertPublicHttpUrl("http://[fe80::1]/"));
await rejects("未指定 0.0.0.0", () => assertPublicHttpUrl("http://0.0.0.0/"));
await rejects("localhost", () => assertPublicHttpUrl("http://localhost/"));
await rejects("子域 .localhost", () => assertPublicHttpUrl("http://app.localhost/"));
await rejects(".internal(云元数据域)", () => assertPublicHttpUrl("http://metadata.google.internal/"));
await rejects("非 http(s) 协议", () => assertPublicHttpUrl("ftp://1.1.1.1/"));
await rejects("URL 携带 userinfo 凭据", () => assertPublicHttpUrl("http://user:pass@example.com/"));

// ---- 2. 合法目标放行(IP 字面量本地归一, 离线可测) ----
await accepts("公网 IPv4 1.1.1.1", () => assertPublicHttpUrl("http://1.1.1.1/"));
await accepts("公网 IPv6 [2606:4700:4700::1111]", () => assertPublicHttpUrl("https://[2606:4700:4700::1111]/"));
await accepts("带端口/路径/查询", () => assertPublicHttpUrl("https://1.1.1.1:8443/a?b=c"));
assert.equal(await assertPublicHttpUrl("https://1.1.1.1/x"), "https://1.1.1.1/x", "返回归一化 href");
ok("返回归一化 href");

// ---- 3. isReservedIp 边界 ----
assert.equal(isReservedIp("8.8.8.8"), false, "8.8.8.8 公网");
assert.equal(isReservedIp("::ffff:8.8.8.8"), false, "v4-mapped 公网展开后放行");
assert.equal(isReservedIp("::ffff:127.0.0.1"), true, "v4-mapped loopback");
assert.equal(isReservedIp("not-an-ip"), true, "未知形态 fail closed");
ok("isReservedIp 边界语义");

// ---- 4. file 渲染目标: LFI 拒绝 + 本地产物放行 ----
await rejects("file:///etc/passwd", () => Promise.resolve(safeFileUrl("/etc/passwd")));
await rejects("file ~/.ssh/id_rsa", () => Promise.resolve(safeFileUrl("/Users/someone/.ssh/id_rsa")));
const dir = mkdtempSync(join(tmpdir(), "url-guard-"));
const artifact = join(dir, "demo.html");
writeFileSync(artifact, "<html></html>");
assert.ok((await resolveRenderTarget(artifact)).startsWith("file://"), "本地产物渲染放行");
ok("本地产物 file:// 放行");
assert.ok((await resolveRenderTarget("https://1.1.1.1/")).startsWith("https://"), "resolveRenderTarget http 分支");
ok("resolveRenderTarget http 分支");
rmSync(dir, { recursive: true, force: true });

console.log(`\nurl-guard: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
console.log("url-guard OK ✓");
