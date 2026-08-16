import { Card, EmptyState, Tag } from "../components/basic";
import { signal } from "@preact/signals";

const text = signal("");

export function Tasks() {
  return (
    <div>
      <h1 style="margin-bottom:14px">任务</h1>
      <Card title="新任务">
        <div class="row">
          <input
            style="flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--fg);padding:8px 10px;border-radius:8px"
            placeholder="输入任务描述…(Phase 1 ④ 接入 GitHub 维护闭环后启用)"
            value={text.value}
            onInput={(e) => (text.value = (e.target as HTMLInputElement).value)}
          />
          <button class="btn" disabled>创建</button>
        </div>
        <div class="dim" style="margin-top:8px">MVP:任务下发走 GitHub 维护闭环(Issue → Zen → PR),此处为占位。</div>
      </Card>
      <Card title="任务列表" extra={<Tag text="本地" />}>
        <EmptyState text="暂无任务" />
      </Card>
    </div>
  );
}
