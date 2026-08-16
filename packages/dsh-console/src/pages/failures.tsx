import { signal } from "@preact/signals";
import { Card, Drawer, Tag, EmptyState, fmtTime } from "../components/basic";
import { failures, events } from "../stores/events";

const openKey = signal<string | null>(null);

export function Failures() {
  const groups = failures.value;
  const open = openKey.value;
  const openGroup = groups.find((g) => g.key === open);
  const samples = openGroup
    ? events.value.filter((e) => e.family === "error" && String((e.data as any).taxonomy ?? "") === openGroup.taxonomy).slice(-5)
    : [];
  return (
    <div>
      <h1 style="margin-bottom:14px">失败</h1>
      <Card title={"失败聚合 (" + groups.reduce((n, g) => n + g.count, 0) + ")"}>
        {groups.length === 0 ? (
          <EmptyState text="暂无失败事件 —— 运行良好" />
        ) : groups.map((g) => (
          <div class="list-item" style="cursor:pointer" onClick={() => (openKey.value = g.key)}>
            <div style="flex:1">
              <div><Tag text={g.taxonomy} tone={g.severity} /> <span class="dim">{g.severity}</span></div>
              <div class="dim mono" style="margin-top:2px">{g.lastMessage.slice(0, 80)}</div>
              <div class="dim">最近 {fmtTime(g.lastAt)}</div>
            </div>
            <div class="stat" style="font-size:18px">{g.count}</div>
          </div>
        ))}
      </Card>
      <Drawer open={!!openGroup} title={openGroup?.taxonomy ?? ""} onClose={() => (openKey.value = null)}>
        {openGroup && (
          <>
            <p><Tag text={openGroup.severity} tone={openGroup.severity} /> 共 {openGroup.count} 次 · 最近 {fmtTime(openGroup.lastAt)}</p>
            <h3>样本</h3>
            {samples.length === 0 ? <EmptyState text="无样本" /> : samples.map((s) => (
              <pre>{JSON.stringify(s.data, null, 2)}</pre>
            ))}
            <div class="row" style="margin-top:12px">
              <button class="btn" disabled title="Phase 2">Replay</button>
              <button class="btn" disabled title="Phase 3">Fix</button>
            </div>
          </>
        )}
      </Drawer>
    </div>
  );
}
