import { readWorkflowReport, summaryValid } from '@taskweave/core';
import type { ReadStateStore, WorkspacePort } from '@taskweave/core/ports';
import type { Task, WorkflowRun } from '@taskweave/core/types';
import type { ApiRevision, EventView, EventPage, WorkflowView, ArtifactContentView } from '@taskweave/contracts';
import { ApiFailure } from '../errors.ts';
import { artifactView, taskItem, taskView, workflowItem, reportView, text } from '../presentation/views.ts';

/** Request-scoped snapshots: repeat reads use one revision, never a long-lived cache. */
export class ReadQueries {
  readonly revision: ApiRevision = { workflows: {}, tasks: {} };
  readonly warnings: string[] = [];
  private tasks = new Map<string, Promise<Task>>();
  private workflows = new Map<string, Promise<WorkflowRun>>();
  constructor(readonly store: ReadStateStore, readonly workspace: Pick<WorkspacePort, 'read'>) {}
  async task(id: string): Promise<Task> {
    if (!this.tasks.has(id)) this.tasks.set(id, this.store.load(id));
    const task = await this.tasks.get(id)!; this.revision.tasks[id] = task.seq; return task;
  }
  async workflow(id: string): Promise<WorkflowRun> {
    if (!this.workflows.has(id)) this.workflows.set(id, this.store.loadWorkflow(id));
    const run = await this.workflows.get(id)!; this.revision.workflows[id] = run.seq; return run;
  }
  taskItem = taskItem;
  workflowItem = workflowItem;
  async taskDetail(id: string) {
    const task = await this.task(id);
    let current: boolean | null = null;
    if (task.workflow) {
      try {
        const run = await this.workflow(task.workflow.runId);
        const node = run.nodes.find(node => node.id === task.workflow!.nodeId);
        current = node?.currentAttemptId === task.workflow.attemptId && node.attempts.some(attempt => attempt.id === task.workflow!.attemptId && attempt.taskId === task.id && attempt.status !== 'invalidated');
      } catch { current = false; this.warnings.push('关联工作流不可读取，无法确认当前 attempt。'); }
    }
    let evidenceCurrent = false;
    if (task.summary) {
      // This helper observes evidence only. It never finalizes, validates or saves the task.
      evidenceCurrent = await summaryValid(task, task.summary, this.workspace);
      if (!evidenceCurrent) this.warnings.push('摘要证据已变化或不可读取；不代表当前产物仍然通过验收。');
    }
    return taskView(task, evidenceCurrent, current);
  }
  async workflowDetail(id: string): Promise<WorkflowView> {
    const run = await this.workflow(id);
    const nodes: WorkflowView['nodes'] = [];
    for (const node of run.nodes) {
      const spec = run.definition.nodes.find(spec => spec.id === node.id)!;
      const current = node.attempts.find(attempt => attempt.id === node.currentAttemptId);
      let currentTask: WorkflowView['nodes'][number]['currentTask'];
      if (current) {
        try {
          const task = await this.task(current.taskId);
          if (task.workflow?.runId !== run.id || task.workflow.nodeId !== node.id || task.workflow.attemptId !== current.id) throw new Error('identity mismatch');
          currentTask = { id: task.id, status: task.status, seq: task.seq };
        } catch { this.warnings.push(`节点 ${node.id} 的当前任务暂不可读取或归属不匹配，请重新查询。`); }
      }
      nodes.push({ id: node.id, title: spec.title, kind: spec.kind, goal: text(spec.goal, this.store.workspace, 8_000)!, dependsOn: spec.dependsOn,
        status: node.status, currentAttemptId: node.currentAttemptId, ...(currentTask ? { currentTask } : {}), attempts: node.attempts.map(attempt => ({
          id: attempt.id, number: attempt.number, taskId: attempt.taskId, status: attempt.status, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, invalidatedAt: attempt.invalidatedAt,
          error: text(attempt.error, this.store.workspace), reason: text(attempt.reason, this.store.workspace, 2_000),
          sourceAttempts: attempt.sourceAttempts.map(source => ({ nodeId: source.nodeId, attemptId: source.attemptId })), artifacts: attempt.artifacts.map(artifact => artifactView(attempt.taskId, artifact))
        })) });
    }
    return { ...workflowItem(run), error: text(run.error, this.store.workspace), nodes };
  }
  async report(id: string, observedAt: string) {
    const report = reportView(await readWorkflowReport({ loadWorkflow: id => this.workflow(id), load: id => this.task(id), events: async (id, after) => {
      const events = await this.store.events(id, after);
      if (events.some(event => event.taskId !== id)) throw new Error('Task event identity mismatch');
      return events;
    }, workflowEvents: async (id, after) => {
      const events = await this.store.workflowEvents(id, after);
      if (events.some(event => event.runId !== id)) throw new Error('Workflow event identity mismatch');
      return events;
    } }, id, observedAt), this.store.workspace);
    this.warnings.push(...report.warnings);
    return report;
  }
  async artifact(taskId: string, artifactId: string): Promise<ArtifactContentView> {
    const task = await this.task(taskId);
    const artifact = task.artifacts.find(artifact => artifactView(taskId, artifact).id === artifactId);
    if (!artifact) throw new ApiFailure(404, 'NOT_FOUND', '未找到该任务登记的产物');
    let file;
    try { file = await this.workspace.read(artifact.path); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'NOT_FOUND'].includes(String(error.code))) throw new ApiFailure(404, 'ARTIFACT_MISSING', '产物文件已不存在，无法提供历史内容');
      throw error;
    }
    if (file.hash !== artifact.sha256) throw new ApiFailure(409, 'ARTIFACT_CHANGED', '当前文件与本 attempt 的产物 hash 不一致，历史内容不可用', { artifactId, recordedSha256: artifact.sha256, currentSha256: file.hash });
    const extension = artifact.path.split('.').at(-1)?.toLowerCase();
    return { ...artifactView(taskId, artifact), currentSha256: file.hash, content: file.content, format: extension === 'md' ? 'markdown' : extension === 'json' ? 'json' : 'text', historicalContent: false };
  }
  async events(scope: 'task' | 'workflow', id: string, after: number, limit: number): Promise<EventPage> {
    const snapshot = scope === 'task' ? await this.task(id) : await this.workflow(id);
    if (after > snapshot.seq) throw new ApiFailure(409, 'CURSOR_AHEAD', '事件游标超过当前快照序号，请从最新快照重新同步', { snapshotSeq: snapshot.seq });
    const raw = scope === 'task' ? await this.store.events(id, after) : await this.store.workflowEvents(id, after);
    const selected = raw.filter(event => event.seq <= snapshot.seq).sort((a, b) => a.seq - b.seq);
    const items: EventView[] = [];
    let previous = after;
    let complete = true;
    for (const event of selected) {
      const owner = 'taskId' in event ? event.taskId : event.runId;
      if (owner !== id || !Number.isSafeInteger(event.seq) || event.seq <= previous || !Number.isFinite(Date.parse(event.time))) { complete = false; continue; }
      if (event.seq !== previous + 1) complete = false;
      previous = event.seq;
      const data: EventView['data'] = {};
      for (const key of ['nodeId', 'attemptId', 'taskId', 'name', 'callId', 'validationId', 'code', 'decision', 'kind'] as const) {
        const value = event.data?.[key];
        if (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) data[key] = value;
      }
      if (Number.isSafeInteger(event.data?.step) && Number(event.data.step) >= 0) data.step = Number(event.data.step);
      if (typeof event.data?.replayed === 'boolean') data.replayed = event.data.replayed;
      items.push({ scope, id, seq: event.seq, time: event.time, type: typeof event.type === 'string' && /^[a-z][a-z0-9_.]{0,80}$/.test(event.type) ? event.type : 'event.unknown', data });
    }
    if (previous !== snapshot.seq) complete = false;
    if (!complete) this.warnings.push('事件存在缺失、重复或归属不匹配，时间线不完整。');
    const page = items.slice(0, limit);
    return { items: page, nextAfter: page.at(-1)?.seq ?? after, hasMore: items.length > limit, snapshotSeq: snapshot.seq, complete };
  }
}
