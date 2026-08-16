import { Card, EmptyState, Tag } from "../components/basic";

export function Maintenance() {
  return (
    <div>
      <h1 style="margin-bottom:14px">维护</h1>
      <div class="row">
        <Card title="Autopilot 状态" extra={<Tag text="未启用" tone="high" />}>
          <EmptyState text="GitHub 维护闭环(Phase 1 ④)接入后显示:夜间任务、budget、运行历史" />
        </Card>
        <Card title="夜间报告">
          <EmptyState text="暂无报告" />
        </Card>
      </div>
    </div>
  );
}
