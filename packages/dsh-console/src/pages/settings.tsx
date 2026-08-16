import { signal } from "@preact/signals";
import { Card } from "../components/basic";

const port = signal(localStorage.getItem("dsh-console.port") ?? "3090");
const keep = signal(localStorage.getItem("dsh-console.keep") ?? "5000");
const saved = signal(false);

export function Settings() {
  const save = () => {
    localStorage.setItem("dsh-console.port", port.value);
    localStorage.setItem("dsh-console.keep", keep.value);
    saved.value = true;
    setTimeout(() => (saved.value = false), 1500);
  };
  return (
    <div>
      <h1 style="margin-bottom:14px">设置</h1>
      <Card title="本地偏好">
        <div class="field"><label>Console 端口</label><input value={port.value} onInput={(e) => (port.value = (e.target as HTMLInputElement).value)} /></div>
        <div class="field"><label>事件窗口(条)</label><input value={keep.value} onInput={(e) => (keep.value = (e.target as HTMLInputElement).value)} /></div>
        <button class="btn" onClick={save}>保存</button>
        {saved.value && <span class="dim" style="margin-left:10px">已保存(本地)</span>}
        <div class="dim" style="margin-top:12px">端口实际变更由 dsh-launcher 生命周期管理(后续版本)。</div>
      </Card>
    </div>
  );
}
