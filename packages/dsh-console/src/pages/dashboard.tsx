import { Card, StatusDot, ProgressBar, EmptyState, fmtTime, Tag } from "../components/basic";
import { runningSessions, sessions, failures, events } from "../stores/events";
import { health } from "../stores/health";

export function Dashboard() {
  const running = runningSessions.value;
  const total = sessions.value.length;
  const failCount = failures.value.reduce((n, f) => n + f.count, 0);
  const todayToolCalls = events.value.filter((e) => e.type === "tool.started").length;
  const h = health.value;
  return (
    <div>
      <h1 style="margin-bottom:14px">工作台总览</h1>
      <div class="row" style="margin-bottom:14px">
        <Card title="运行中会话">
          {running.length === 0 ? <EmptyState text="暂无运行中会话" /> : running.map((s) => (
            <div class="list-item">
              <StatusDot ok />
              <div style="flex:1">
                <div>{s.title}</div>
                <div class="dim">{s.model || "model 未知"} · 工具调用 {s.tools} 次 · 轮次 {s.turns}</div>
              </div>
            </div>
          ))}
        </Card>
        <Card title="今日快照">
          <div class="grid2">
            <div><div class="stat">{total}</div><div class="dim">会话总数</div></div>
            <div><div class="stat">{todayToolCalls}</div><div class="dim">工具调用</div></div>
            <div><div class="stat">{failCount}</div><div class="dim">失败事件</div></div>
            <div><div class="stat">{h?.count ?? "—"}</div><div class="dim">事件库条数</div></div>
          </div>
        </Card>
      </div>
      <div class="row">
        <Card title="健康条" extra={<Tag text={h?.server ?? "离线"} tone={h ? "low" : "high"} />}>
          {h ? (
            <div class="grid2">
              <div><div class="dim">事件库目录</div><div class="mono">{h.eventsDir}</div></div>
              <div><div class="dim">最新 seq</div><div class="stat" style="font-size:16px">{h.seq}</div></div>
            </div>
          ) : <EmptyState text="等待 /api/health/summary…" />}
        </Card>
        <Card title="最新活动">
          <div class="feed">
            {events.value.slice(-8).reverse().map((e) => (
              <div class="list-item">
                <Tag text={e.type} />
                <span class="dim mono">{fmtTime(e.at)}</span>
              </div>
            ))}
            {events.value.length === 0 && <EmptyState text="尚无事件,等待运行时产生" />}
          </div>
        </Card>
      </div>
    </div>
  );
}
