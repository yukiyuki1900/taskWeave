import { useState } from 'react';
import type { Page, TaskListItem, WorkflowListItem } from '@taskweave/contracts';
import { useQuery } from '../data/use-query.ts';
import { useDataSource } from '../data/source.tsx';
import { href } from '../data/routes.ts';
import { Badge, Empty, number, Panel, QueryFeedback, time } from '../components/common.tsx';

const workflowStatuses = [
  'pending',
  'running',
  'waiting_input',
  'waiting_acceptance',
  'completed',
  'failed',
  'cancelled',
];
const taskStatuses = [
  'pending',
  'running',
  'waiting_input',
  'validating',
  'validation_failed',
  'waiting_acceptance',
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
];
export function RunList({ collection }: { collection: 'workflows' | 'tasks' }) {
  const { mode } = useDataSource();
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState('standalone');
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors.at(-1);
  const params = new URLSearchParams({ limit: '20' });
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  if (collection === 'tasks') params.set('scope', scope);
  const query = useQuery<Page<WorkflowListItem | TaskListItem>>(
    `/api/v1/${collection}?${params}`,
    cursors.length === 1,
  );
  const page = query.response?.data;
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">WORKSPACE / {collection.toUpperCase()}</p>
          <h1>{collection === 'workflows' ? '工作流运行' : '任务记录'}</h1>
          <p>从目标到交付，查看每一次执行的状态与依据。</p>
        </div>
        <button onClick={query.refresh}>↻ 刷新</button>
      </header>
      <Panel
        title="运行列表"
        aside={
          <span className="tag">
            {mode === 'demo'
              ? '录制快照'
              : cursors.length === 1
                ? '每 2 秒更新'
                : '历史分页 · 手动刷新'}
          </span>
        }
      >
        <div className="toolbar filters">
          <label>
            状态
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setCursors([null]);
              }}
            >
              <option value="">全部状态</option>
              {(collection === 'tasks' ? taskStatuses : workflowStatuses).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {collection === 'tasks' && (
            <label>
              任务范围
              <select
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                  setCursors([null]);
                }}
              >
                <option value="standalone">独立任务</option>
                <option value="all">全部任务（含工作流）</option>
              </select>
            </label>
          )}
          <p className="footnote">观察于 {time(query.response?.observedAt)}</p>
        </div>
        <QueryFeedback query={query} />
        {page &&
          (!page.items.length ? (
            <Empty>暂无符合条件的记录。请先通过 CLI 执行任务或工作流。</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>名称 / 标识</th>
                    <th>状态</th>
                    <th>{collection === 'workflows' ? '节点进度' : '执行 / Token'}</th>
                    <th>最后更新</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <a
                          className="row-title"
                          href={href({
                            collection,
                            id: item.id,
                            tab: 'result',
                          })}
                        >
                          {'name' in item ? item.name : item.title}
                        </a>
                        <code className="row-id">{item.id}</code>
                        {'workflow' in item && item.workflow && (
                          <small>工作流节点 {item.workflow.nodeId}</small>
                        )}
                      </td>
                      <td>
                        <Badge status={item.status} />
                      </td>
                      <td>
                        {'succeededNodes' in item ? (
                          <>
                            <strong>
                              {item.succeededNodes} / {item.totalNodes}
                            </strong>
                            <small>成功节点</small>
                          </>
                        ) : (
                          <>
                            <strong>
                              {item.steps} / {item.maxSteps} 步
                            </strong>
                            <small>
                              {number(item.usage.input + item.usage.output)} Token · {item.kind} ·{' '}
                              {item.providerMode}
                            </small>
                          </>
                        )}
                      </td>
                      <td>
                        {time(item.updatedAt)}
                        <small>seq {item.seq}</small>
                      </td>
                      <td>
                        <a
                          className="open-link"
                          aria-label={`查看 ${'name' in item ? item.name : item.title}`}
                          href={href({
                            collection,
                            id: item.id,
                            tab: 'result',
                          })}
                        >
                          查看 →
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        <div className="pagination">
          <span className="footnote">第 {cursors.length} 页 · 每页最多 20 条</span>
          <button
            disabled={cursors.length === 1}
            onClick={() => setCursors((previous) => previous.slice(0, -1))}
          >
            上一页
          </button>
          <button
            disabled={!page?.nextCursor || !!query.error || query.loading}
            onClick={() => {
              if (page?.nextCursor) setCursors((previous) => [...previous, page.nextCursor]);
            }}
          >
            下一页
          </button>
          <button disabled={cursors.length === 1} onClick={() => setCursors([null])}>
            回到最新
          </button>
        </div>
      </Panel>
    </>
  );
}
