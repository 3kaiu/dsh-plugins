import { Card, EmptyState, ProgressBar, Tag, fmtTime } from "../components/basic";
import { sessions, events } from "../stores/events";

export function Sessions() {
  const all = sessions.value;
  const feed = [...events.value].reverse().slice(0, 120);
  return (
    <div>
      <h1 style="margin-bottom:14px">会话</h1>
      <div class="row">
        <Card title={"会话列表 (" + all.length + ")"} style="">
          {all.length === 0 ? <EmptyState text="暂无会话" /> : all.map((s) => (
            <div class="list-item">
              <div style="flex:1">
                <div>{s.title}</div>
                <div class="dim mono">{s.id.slice(0, 20)}… · {s.model || "model 未知"}</div>
                <div class="dim">{s.completedAt ? "已完成 " + fmtTime(s.completedAt) : "运行中"} · 轮次 {s.turns} · tokens {s.tokens.in}/{s.tokens.out} · 工具 {s.tools}</div>
              </div>
              {s.completedAt ? <Tag text={s.reason || "completed"} /> : <Tag text="运行中" tone="low" />}
            </div>
          ))}
        </Card>
        <Card title="活动流(近 120 条)">
          <div class="feed">
            {feed.map((e) => (
              <div class="list-item">
                <Tag text={e.type} />
                <span class="dim mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{e.sessionId ?? ""}</span>
                <span class="dim mono">{fmtTime(e.at)}</span>
              </div>
            ))}
            {feed.length === 0 && <EmptyState text="尚无事件" />}
          </div>
        </Card>
      </div>
    </div>
  );
}
