import { signal } from "@preact/signals";
import { Card } from "../components/basic";
import { PluginSettings } from "../components/plugin-settings";
import { setMaxWindow } from "../stores/events";

// 事件窗口:持久化 + 实时生效(events store 的 ingest 按此裁剪)
const keep = signal(localStorage.getItem("dsh-console.keep") ?? "5000");
const saved = signal(false);

export function Settings() {
  const save = () => {
    const n = Math.max(100, Math.min(50000, Number(keep.value) || 5000));
    setMaxWindow(n);
    keep.value = String(n);
    saved.value = true;
    setTimeout(() => (saved.value = false), 1500);
  };
  return (
    <div>
      <h1 style="margin-bottom:14px">设置</h1>
      <Card title="本地偏好">
        <div class="field"><label>事件窗口(条,100-50000)</label><input value={keep.value} onInput={(e) => (keep.value = (e.target as HTMLInputElement).value)} /></div>
        <button class="btn" onClick={save}>保存</button>
        {saved.value && <span class="dim" style="margin-left:10px">已保存,立即生效</span>}
        <div class="dim" style="margin-top:12px">
          Console 端口由启动时的服务地址决定(本页面地址即所连端口);若需变更端口,请通过
          dsh-launcher 重启 Console 后访问新地址。
        </div>
      </Card>
      <Card title="插件配置">
        <PluginSettings />
      </Card>
    </div>
  );
}