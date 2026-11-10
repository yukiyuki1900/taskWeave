import type { ApiRevision, ReportView, WorkflowView } from '@taskweave/contracts';
import type { Route } from '../data/routes.ts';
import { href } from '../data/routes.ts';
import { useQuery } from '../data/use-query.ts';
import { Badge, Empty, Meta, Notice, Panel, QueryFeedback, time } from '../components/common.tsx';
import { Metrics } from '../components/metrics.tsx';
import { Graph } from '../components/graph.tsx';
import { TaskDetail } from '../components/task-detail.tsx';
import { Events } from '../components/events.tsx';

export function revisionsDiffer(a: ApiRevision, b: ApiRevision) {
  return (['tasks', 'workflows'] as const).some((kind) =>
    Object.entries(a[kind]).some(([id, seq]) => b[kind][id] !== undefined && b[kind][id] !== seq),
  );
}
export function WorkflowPage({ route }: { route: Route & { id: string } }) {
  const query = useQuery<WorkflowView>(`/api/v1/workflows/${route.id}`);
  const report = useQuery<ReportView>(`/api/v1/workflows/${route.id}/report`);
  const run = query.response?.data;
  const node = route.node ? run?.nodes.find((item) => item.id === route.node) : run?.nodes[0];
  const attempt = route.attempt
    ? node?.attempts.find((item) => item.id === route.attempt)
    : node?.attempts.find((item) => item.id === node.currentAttemptId);
  return (
    <>
      <header className="page-heading">
        <div>
          <a className="back" href="#/workflows">
            ← 工作流运行
          </a>
          <h1>{run?.name ?? '工作流详情'}</h1>
          <code>{route.id}</code>
        </div>
        <div className="heading-actions">
          {run && <Badge status={run.status} />}
          <button
            onClick={() => {
              query.refresh();
              report.refresh();
            }}
          >
            ↻ 刷新
          </button>
        </div>
      </header>
      <QueryFeedback query={query} />
      {run && (
        <>
          <dl className="metadata header-meta">
            <Meta label="创建于">{time(run.createdAt)}</Meta>
            <Meta label="观察于">{time(query.response?.observedAt)}</Meta>
            <Meta label="工作流序号">{run.seq}</Meta>
            <Meta label="运行方式">本地 · 只读</Meta>
          </dl>
          {run.error && <Notice>{run.error}</Notice>}
          {query.response &&
            report.response &&
            revisionsDiffer(query.response.revision, report.response.revision) && (
              <Notice>工作流与报告观察到不同序号，正在分别刷新；文件读取不提供跨对象事务。</Notice>
            )}
          <QueryFeedback query={report} />
          {report.response && (
            <>
              <Metrics report={report.response.data} />
              <p className="footnote report-observed">
                报告观察至 {time(report.response.data.observedUntil)} · 查询于{' '}
                {time(report.response.observedAt)}
              </p>
            </>
          )}
          <Panel
            title="执行依赖"
            aside={<span className="footnote">点击节点查看 attempt 与交付内容</span>}
          >
            <Graph nodes={run.nodes} selected={node?.id} route={route} />
          </Panel>
          {node ? (
            <>
              <div className="node-heading">
                <div>
                  <p className="eyebrow">NODE / {node.kind.toUpperCase()}</p>
                  <h2>{node.title}</h2>
                  <p className="footnote">
                    {node.id} · 依赖 {node.dependsOn.join('、') || '无'}
                  </p>
                </div>
                <Badge status={node.status} />
              </div>
              <div className="attempt-picker">
                <label>
                  执行尝试
                  <select
                    value={attempt?.id ?? ''}
                    onChange={(event) => {
                      window.location.hash = href({
                        ...route,
                        node: node.id,
                        attempt: event.target.value,
                      }).slice(1);
                    }}
                  >
                    <option value="" disabled>
                      尚无所选 attempt
                    </option>
                    {node.attempts.map((item) => (
                      <option key={item.id} value={item.id}>
                        #{item.number} {item.id}{' '}
                        {item.id === node.currentAttemptId ? '· 当前' : '· 历史'}{' '}
                        {item.invalidatedAt ? '· 已过期' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {attempt && (
                  <span className="footnote">
                    {time(attempt.startedAt)} → {time(attempt.finishedAt)} · {attempt.status}
                  </span>
                )}
              </div>
              {attempt ? (
                <>
                  {attempt.invalidatedAt && (
                    <Notice>
                      该 attempt 已于 {time(attempt.invalidatedAt)} 过期。
                      {attempt.reason}
                    </Notice>
                  )}
                  {attempt.error && <Notice>{attempt.error}</Notice>}
                  <TaskDetail
                    key={attempt.taskId}
                    id={attempt.taskId}
                    route={{ ...route, node: node.id, attempt: attempt.id }}
                  />
                </>
              ) : (
                <Empty>
                  {route.attempt
                    ? '指定 attempt 不属于此节点，请重新选择。'
                    : '该节点尚无当前 attempt，或当前记录不可用。'}
                </Empty>
              )}
            </>
          ) : (
            <Empty>{route.node ? '指定节点不存在。' : '暂无节点。'}</Empty>
          )}
          <Panel title="工作流事件">
            <Events scope="workflow" id={run.id} />
          </Panel>
        </>
      )}
    </>
  );
}
