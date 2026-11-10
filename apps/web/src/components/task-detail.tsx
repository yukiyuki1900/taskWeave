import { useState } from 'react';
import type {
  ArtifactContentView,
  ArtifactView,
  StatementView,
  SummaryView,
  TaskView,
} from '@taskweave/contracts';
import type { Route } from '../data/routes.ts';
import { href, tabs } from '../data/routes.ts';
import { useQuery } from '../data/use-query.ts';
import { QueryError } from '../data/client.ts';
import { Badge, Empty, Meta, Notice, Panel, QueryFeedback, RichText, time } from './common.tsx';
import { Events } from './events.tsx';

const tabLabels = {
  result: '结果',
  artifacts: '产物',
  validation: '验证与验收',
  context: '摘要与交接',
  skills: 'Skill',
  events: '事件',
};
export function TaskDetail({ id, route }: { id: string; route: Route }) {
  const query = useQuery<TaskView>(`/api/v1/tasks/${id}`);
  const task = query.response?.data;
  return (
    <>
      <QueryFeedback query={query} />
      {task && (
        <Panel title={task.title} aside={<Badge status={task.status} />}>
          <dl className="metadata">
            <Meta label="Task">
              <code>{task.id}</code>
            </Meta>
            <Meta label="步骤">
              {task.steps} / {task.maxSteps}
            </Meta>
            <Meta label="观察序号">{task.seq}</Meta>
            <Meta label="更新于">{time(task.updatedAt)}</Meta>
          </dl>
          {task.currentAttempt === false && (
            <Notice>
              这是历史 attempt 的任务记录，不代表该节点当前结果。文件仍从当前工作区读取，须通过 hash
              校验。
            </Notice>
          )}
          <nav className="tabs" aria-label="任务详情">
            {tabs.map((tab) => (
              <a
                key={tab}
                href={href({ ...route, tab })}
                aria-current={route.tab === tab ? 'page' : undefined}
              >
                {tabLabels[tab]}
                {tab === 'artifacts' ? ` ${task.artifacts.length}` : ''}
              </a>
            ))}
          </nav>
          <div className="tab-content">
            {route.tab === 'result' && (
              <>
                <h3>任务目标</h3>
                <RichText text={task.goal} />
                {task.acceptanceCriteria.length > 0 && (
                  <>
                    <h3>验收标准</h3>
                    <ul>
                      {task.acceptanceCriteria.map((criterion, i) => (
                        <li key={i}>{criterion}</li>
                      ))}
                    </ul>
                  </>
                )}
                {task.error && <Notice>执行错误：{task.error}</Notice>}
                {task.question && (
                  <Notice>
                    <strong>等待人工输入</strong>
                    <p>{task.question}</p>
                    <small>请使用 CLI 回答，Web 只读。</small>
                  </Notice>
                )}
                <h3>执行结果</h3>
                {task.answer ? <RichText text={task.answer} /> : <Empty>尚无最终回答。</Empty>}
                {task.answerTruncated && (
                  <Notice>回答超过 20,000 字符，当前为预览；完整内容保留在本地检查点。</Notice>
                )}
                {task.childTaskIds.length > 0 && (
                  <>
                    <h3>子任务</h3>
                    <ul>
                      {task.childTaskIds.map((child) => (
                        <li key={child}>
                          <a
                            href={href({
                              collection: 'tasks',
                              id: child,
                              tab: 'result',
                            })}
                          >
                            {child}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {task.workflow && (
                  <p className="footnote">
                    归属工作流{' '}
                    <a
                      href={href({
                        collection: 'workflows',
                        id: task.workflow.runId,
                        node: task.workflow.nodeId,
                        attempt: task.workflow.attemptId,
                        tab: 'result',
                      })}
                    >
                      {task.workflow.runId}
                    </a>
                  </p>
                )}
              </>
            )}
            {route.tab === 'artifacts' && <Artifacts key={task.id} task={task} />}
            {route.tab === 'validation' && <Validation task={task} />}
            {route.tab === 'context' && <Context task={task} />}
            {route.tab === 'skills' && (
              <>
                <Notice>
                  展示创建任务时绑定的 Skill 版本，不表示当前文件仍匹配；页面不会执行或升级 Skill。
                </Notice>
                {!task.skills.length ? (
                  <Empty>该任务未绑定 Skill。</Empty>
                ) : (
                  task.skills.map((skill) => (
                    <article className="record" key={skill.id}>
                      <h3>
                        {skill.id} <span className="tag">v{skill.version}</span>
                      </h3>
                      <p>{skill.description}</p>
                      <code>{skill.path}</code>
                      <p className="hash">SHA-256 {skill.sha256}</p>
                    </article>
                  ))
                )}
              </>
            )}
            {route.tab === 'events' && <Events scope="task" id={id} />}
          </div>
        </Panel>
      )}
    </>
  );
}
function Validation({ task }: { task: TaskView }) {
  return (
    <>
      {task.validation ? (
        <>
          <div className="toolbar">
            <h3>独立验证</h3>
            <Badge status={task.validation.status} />
          </div>
          <p className="footnote">
            {task.validation.id} · {time(task.validation.startedAt)} →{' '}
            {time(task.validation.finishedAt)}
          </p>
          {task.validation.items.map((item, i) => (
            <article className="record" key={i}>
              <Badge status={item.passed ? 'passed' : 'failed'} /> <strong>{item.name}</strong>
              <p>{item.detail}</p>
              {item.check && (
                <p className="footnote">
                  检查 {item.check.name} · {item.check.status} · exit {item.check.exitCode ?? '—'} ·{' '}
                  {item.check.durationMs} ms
                </p>
              )}
            </article>
          ))}
        </>
      ) : (
        <Empty>尚无独立验证记录。</Empty>
      )}
      <h3>人工验收</h3>
      {task.approval ? (
        <article className="record">
          <Badge status={task.approval.decision} />
          <p>{task.approval.note}</p>
          <p className="footnote">
            {time(task.approval.time)} · 验证 {task.approval.validationId}
          </p>
        </article>
      ) : (
        <Empty>尚无人工验收意见。验收请通过 CLI 执行。</Empty>
      )}
    </>
  );
}
function Statements({ title, items }: { title: string; items: StatementView[] }) {
  return items.length ? (
    <>
      <h4>{title}</h4>
      {items.map((item, i) => (
        <article className="statement" key={i}>
          <p>{item.text}</p>
          <details>
            <summary>查看证据（{item.evidence.length}）</summary>
            {item.evidence.map((evidence, j) => (
              <p className="hash" key={j}>
                {evidence.kind} {evidence.path ?? evidence.callId ?? ''}
                <br />
                SHA-256 {evidence.sha256}
              </p>
            ))}
          </details>
        </article>
      ))}
    </>
  ) : null;
}
function Summary({ summary }: { summary: SummaryView | Omit<SummaryView, 'evidenceCurrent'> }) {
  return (
    <>
      <p>
        <span className="tag">{summary.kind === 'model' ? '模型摘要' : '提取式摘要'}</span>{' '}
        <span className="tag">记录状态 {summary.status}</span>
        {'evidenceCurrent' in summary && (
          <span className="tag">证据{summary.evidenceCurrent ? '仍匹配' : '不匹配'}</span>
        )}
      </p>
      <p className="footnote">
        {summary.id} · {time(summary.updatedAt)}
      </p>
      <Statements title="事实" items={summary.facts} />
      <Statements title="决策" items={summary.decisions} />
      <Statements title="约束" items={summary.constraints} />
      <Statements title="待解决" items={summary.openQuestions} />
      {summary.outcome && <Statements title="结论" items={[summary.outcome]} />}
    </>
  );
}
function Context({ task }: { task: TaskView }) {
  return (
    <>
      <h3>任务摘要</h3>
      {task.summary ? (
        <>
          <Summary summary={task.summary} />
          <p className="footnote">证据匹配仅表示来源一致性，不代表业务正确或整条交接链有效。</p>
        </>
      ) : (
        <Empty>暂无任务摘要，旧任务也可能没有摘要。</Empty>
      )}
      <h3>上游交接</h3>
      {task.handoff ? (
        <>
          <p className="hash">交接摘要 hash {task.handoff.digest}</p>
          {task.handoff.sources.map((source) => (
            <article className="record" key={`${source.nodeId}:${source.attemptId}`}>
              <h4>{source.nodeId}</h4>
              <dl className="metadata">
                <Meta label="来源 attempt">
                  <code>{source.attemptId}</code>
                </Meta>
                <Meta label="来源任务">
                  <a
                    href={href({
                      collection: 'tasks',
                      id: source.taskId,
                      tab: 'context',
                    })}
                  >
                    {source.taskId}
                  </a>
                </Meta>
                <Meta label="验证记录">
                  <code>{source.validationId}</code>
                </Meta>
                <Meta label="来源验收">
                  {source.approval ? <Badge status={source.approval.decision} /> : '无'}
                </Meta>
              </dl>
              <Summary summary={source.summary} />
              {source.artifacts.map((artifact) => (
                <p className="hash" key={artifact.id}>
                  {artifact.path}
                  <br />
                  SHA-256 {artifact.recordedSha256}
                </p>
              ))}
            </article>
          ))}
        </>
      ) : (
        <Empty>无上游交接记录。</Empty>
      )}
    </>
  );
}
function Artifacts({ task }: { task: TaskView }) {
  const [selected, setSelected] = useState<string>();
  const artifact = task.artifacts.find((item) => item.id === selected);
  return (
    <>
      <p className="footnote">
        仅预览已登记的 UTF-8 文本文件，最大 512 KiB；校验当前文件 hash，无历史文件快照。
      </p>
      {!task.artifacts.length ? (
        <Empty>尚无已登记产物。</Empty>
      ) : (
        <div className="artifact-layout">
          <ul className="artifact-list">
            {task.artifacts.map((item) => (
              <li key={item.id}>
                <button
                  className={selected === item.id ? 'active' : ''}
                  onClick={() => setSelected(item.id)}
                >
                  <strong>{item.path}</strong>
                  <small>{item.bytes.toLocaleString()} bytes</small>
                </button>
              </li>
            ))}
          </ul>
          <div>
            {artifact ? (
              <ArtifactPreview key={artifact.id} taskId={task.id} artifact={artifact} />
            ) : (
              <Empty>选择产物以查看内容。</Empty>
            )}
          </div>
        </div>
      )}
    </>
  );
}
function ArtifactPreview({ taskId, artifact }: { taskId: string; artifact: ArtifactView }) {
  const query = useQuery<ArtifactContentView>(`/api/v1/tasks/${taskId}/artifacts/${artifact.id}`);
  const [raw, setRaw] = useState(false);
  const error = query.error;
  // Never keep a formerly valid file preview visible after a failed hash recheck.
  const file = !error ? query.response?.data : undefined;
  return (
    <>
      <div className="toolbar">
        <h3>{artifact.path}</h3>
        <button onClick={() => setRaw((value) => !value)}>{raw ? '格式预览' : '原始文本'}</button>
      </div>
      <p className="hash">记录 SHA-256 {artifact.recordedSha256}</p>
      {query.loading && <Empty>正在读取产物…</Empty>}
      {error && (
        <div role="alert" className="notice error">
          <strong>
            {error instanceof QueryError && error.code === 'ARTIFACT_CHANGED'
              ? '产物已变化，无法查看该 attempt 记录的版本。'
              : error.message}
          </strong>
          {error instanceof QueryError &&
            error.details &&
            Object.entries(error.details).map(([key, value]) => (
              <p className="hash" key={key}>
                {key}: {value}
              </p>
            ))}
          <button onClick={query.refresh}>重新校验</button>
        </div>
      )}
      {file && (
        <>
          <p className="hash">当前 SHA-256 {file.currentSha256}</p>
          {file.format === 'markdown' && !raw ? (
            <RichText text={file.content} />
          ) : (
            <pre className="code-preview">
              {file.format === 'json' && !raw ? prettyJson(file.content) : file.content}
            </pre>
          )}
        </>
      )}
    </>
  );
}
function prettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
