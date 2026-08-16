import { Card, ProgressBar, EmptyState, fmtTime } from "../components/basic";
import { health, healthError } from "../stores/health";

export function Health() {
  const h = health.value;
  const families = h?.families ?? {};
  const total = h?.count ?? 0;
  return (
    <div>
      <h1 style="margin-bottom:14px">健康</h1>
      <div class="row">
        <Card title="事件库">
          {h ? (
            <div class="grid2">
              <div><div class="dim">总条数</div><div class="stat">{total}</div></div>
              <div><div class="dim">最新 seq</div><div class="stat">{h.seq}</div></div>
              <div><div class="dim">事件目录</div><div class="mono">{h.eventsDir}</div></div>
              <div><div class="dim">刷新于</div><div>{fmtTime(h.at)}</div></div>
            </div>
          ) : <EmptyState text={healthError.value ?? "等待健康数据…"} />}
        </Card>
        <Card title="五族分布">
          {total === 0 ? <EmptyState text="暂无数据" /> : Object.entries(families).map(([fam, n]) => (
            <div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between"><span class="mono">{fam}</span><span class="dim">{n}</span></div>
              <ProgressBar value={n} max={total} tone={fam === "error" && n > 0 ? "warn" : "ok"} />
            </div>
          ))}
        </Card>
      </div>
      <Card title="归因分析(Phase 4 占位)">
        <EmptyState text="Agent Score / 归因面板将在 Phase 4 填充" />
      </Card>
    </div>
  );
}
