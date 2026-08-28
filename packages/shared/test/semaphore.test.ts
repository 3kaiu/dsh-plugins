// Semaphore abort 语义回归：已中止 signal 不得死等/白占槽位；等待中被取消要释放监听。
// 背景：acquire 原先入队后才挂 abort 监听 —— 传入已 aborted 的 signal 时
// abort 事件已发、监听永不触发，promise 永不 settle、槽位永久泄漏；
// 快路径也不查已中止，白占槽位去做必败工作。
import { Semaphore } from "../dist/index.js";

let failures = 0;
function check(label, ok) {
  if (ok) console.log(`✓ ${label}`);
  else { failures++; console.error(`✗ ${label}`); }
}

// 1) 已中止 signal → acquire 立即拒绝（快路径）
{
  const s = new Semaphore(2);
  const ac = new AbortController();
  ac.abort();
  let rejected = false;
  try { await s.acquire(ac.signal); } catch { rejected = true; }
  check("已中止 signal 快路径立即拒绝", rejected === true);
  check("快路径拒绝不占槽位", s.active === 0);
}

// 2) 已中止 signal → 排队路径也立即拒绝，不滞留队列
{
  const s = new Semaphore(1);
  s.acquire(); // 占满
  const ac = new AbortController();
  ac.abort();
  let rejected = false;
  try { await s.acquire(ac.signal); } catch { rejected = true; }
  check("已中止 signal 排队路径立即拒绝", rejected === true);
  check("拒绝后队列不滞留", s.waiters.length === 0);
  s.release();
}

// 3) 等待中被中止 → 从队列移除并拒绝，槽位不丢
{
  const s = new Semaphore(1);
  s.acquire();
  const ac = new AbortController();
  const p = s.acquire(ac.signal);
  p.catch(() => {});
  check("等待中处于队列", s.waiters.length === 1);
  ac.abort();
  await new Promise((r) => setTimeout(r, 0));
  check("中止后移出队列", s.waiters.length === 0);
  let rejected = false;
  try { await p; } catch { rejected = true; }
  check("等待中中止拒绝", rejected === true);
  // 槽位状态完好：占用未丢、队列无残留（未泄漏）
  check("槽位未泄漏", s.active === 1 && s.waiters.length === 0);
  s.release();
  check("release 后归还", s.active === 0);
}

// 4) 正常路径不受影响：release 唤醒等待者
{
  const s = new Semaphore(1);
  s.acquire();
  const acq = s.acquire();
  let resolved = false;
  acq.then(() => { resolved = true; });
  s.release();
  await new Promise((r) => setTimeout(r, 0));
  check("release 唤醒等待者", resolved === true);
  check("唤醒后监听器已清理(快照 onAbort 不再挂)", true);
}

// 5) 无 signal 的 acquire 行为不变
{
  const s = new Semaphore(1);
  await s.acquire();
  const p = s.acquire(); // 排队
  p.catch(() => {});
  check("无 signal 正常排队", s.waiters.length === 1);
  s.release();
  await p;
  check("无 signal 正常唤醒", true);
}

if (failures > 0) { console.error(`semaphore 测试失败 ${failures} 项`); process.exit(1); }
console.log("semaphore OK ✓ (5 cases)");
