import type { WorkflowCost, WorkflowReport, WorkflowTiming, TaskEvent } from '../types.ts';
import type { StateStore } from '../ports/index.ts';
import { TaskWeaveError } from '../errors.ts';

type Interval = [number, number];
type ReportStore = Pick<StateStore, 'loadWorkflow' | 'workflowEvents' | 'load' | 'events'>;
const emptyCost = (): WorkflowCost => ({ inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, toolFailures: 0 });
const timestamp = (value: string | undefined): number => value === undefined ? NaN : Date.parse(value);
const completeEvents = (events: Array<{ seq: number }>, seq: number): boolean =>
  Number.isSafeInteger(seq) && seq >= 0 && events.length === seq && events.every((event, index) => event.seq === index + 1);

function duration(intervals: Interval[]): number {
  let total = 0;
  let end = -Infinity;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}

function timing(start: number, end: number, active: Interval[], waiting: Interval[], complete: boolean): WorkflowTiming {
  const elapsedMs = Math.max(0, end - start);
  const executionMs = duration(active);
  // Other independent nodes can execute while one node waits; do not count overlap twice.
  const humanWaitMs = duration([...active, ...waiting]) - executionMs;
  return { elapsedMs, executionMs, humanWaitMs, unattributedMs: Math.max(0, elapsedMs - executionMs - humanWaitMs), complete };
}

function taskIntervals(events: TaskEvent[], start: number, end: number): { active: Interval[]; waiting: Interval[]; complete: boolean } {
  const active: Interval[] = [];
  const waiting: Interval[] = [];
  let executing: number | undefined;
  let awaiting: number | undefined;
  let last = start;
  let complete = true;
  const close = (at: number): void => {
    if (executing !== undefined) active.push([executing, at]);
    if (awaiting !== undefined) waiting.push([awaiting, at]);
    executing = awaiting = undefined;
  };
  for (const event of events) {
    const at = timestamp(event.time);
    if (!Number.isFinite(at) || at < last) { complete = false; continue; }
    if (at > end) break;
    if (event.type === 'task.started' || event.type === 'validation.started') {
      if (event.type === 'task.started' && executing !== undefined) {
        // A new invocation after an unclosed one does not prove execution during the crash gap.
        active.push([executing, last]); executing = undefined; complete = false;
      }
      if (awaiting !== undefined) { waiting.push([awaiting, at]); awaiting = undefined; }
      executing ??= at;
    } else if (/^task\.(waiting_input|waiting_acceptance|failed|cancelled|completed|validation_failed|budget_exceeded)$/.test(event.type)) {
      close(at);
      if (event.type === 'task.waiting_input' || event.type === 'task.waiting_acceptance') awaiting = at;
    } else if (event.type === 'acceptance.recorded' || event.type === 'input.received') {
      if (awaiting !== undefined) { waiting.push([awaiting, at]); awaiting = undefined; }
    }
    last = at;
  }
  if (executing !== undefined) { active.push([executing, last]); complete = false; }
  if (awaiting !== undefined) waiting.push([awaiting, end]);
  return { active, waiting, complete };
}

/** Reads v1 checkpoints and events only. Does not reconcile, validate, invoke models or save state. */
export async function readWorkflowReport(store: ReportStore, id: string, generatedAt = new Date().toISOString()): Promise<WorkflowReport> {
  const asOf = timestamp(generatedAt);
  if (!Number.isFinite(asOf)) throw new TaskWeaveError('INVALID_REPORT_TIME', '报告生成时间无效');
  const run = await store.loadWorkflow(id);
  const start = timestamp(run.createdAt);
  if (!Number.isFinite(start) || start > asOf) throw new TaskWeaveError('INVALID_REPORT_TIME', '工作流创建时间无效或晚于报告时间');
  const warnings: string[] = [];
  let dataComplete = true;
  let workflowEvents: Awaited<ReturnType<ReportStore['workflowEvents']>> = [];
  try { workflowEvents = (await store.workflowEvents(id)).filter(event => event.seq <= run.seq); }
  catch { dataComplete = false; warnings.push('工作流事件不可读取，人工操作和时间统计可能不完整。'); }
  if (!workflowEvents.length || !completeEvents(workflowEvents, run.seq)) {
    dataComplete = false; warnings.push('工作流事件缺失或序号不连续，无法确认完整历史。');
  }
  const stopped = ['completed', 'failed', 'cancelled'].includes(run.status);
  const terminal = [...workflowEvents].reverse().find(event => event.type === `workflow.${run.status}`);
  const terminalAt = timestamp(terminal?.time ?? run.updatedAt);
  const end = stopped && Number.isFinite(terminalAt) ? Math.max(start, Math.min(asOf, terminalAt)) : asOf;
  let timeComplete = !stopped || Boolean(terminal && Number.isFinite(timestamp(terminal.time)));
  const nodes: WorkflowReport['nodes'] = [];
  const allActive: Interval[] = [];
  const allWaiting: Interval[] = [];
  const total = emptyCost();
  const current = emptyCost();
  for (const node of run.nodes) {
    const attempts: WorkflowReport['nodes'][number]['attempts'] = [];
    for (const attempt of node.attempts) {
      const parsedStart = timestamp(attempt.startedAt);
      const attemptStart = Number.isFinite(parsedStart) ? Math.min(end, Math.max(start, parsedStart)) : start;
      const parsedEnd = timestamp(attempt.invalidatedAt ?? attempt.finishedAt);
      const attemptEnd = Number.isFinite(parsedEnd) ? Math.max(attemptStart, Math.min(end, parsedEnd)) : end;
      const cost = emptyCost();
      let taskStatus;
      let available = true;
      let intervals = { active: [] as Interval[], waiting: [] as Interval[], complete: false };
      try {
        const task = await store.load(attempt.taskId);
        if (task.workflow?.runId !== run.id || task.workflow.nodeId !== node.id || task.workflow.attemptId !== attempt.id) {
          throw new TaskWeaveError('REPORT_TASK_MISMATCH', '任务归属不匹配');
        }
        taskStatus = task.status;
        const count = (value: number): number => {
          if (Number.isSafeInteger(value) && value >= 0) return value;
          available = false; return 0;
        };
        cost.inputTokens = count(task.usage?.input);
        cost.outputTokens = count(task.usage?.output);
        cost.modelCalls = count(task.steps);
        const events = (await store.events(task.id)).filter(event => event.seq <= task.seq);
        cost.toolCalls = events.filter(event => event.type === 'tool.started').length;
        cost.toolFailures = events.filter(event => event.type === 'tool.failed').length;
        intervals = taskIntervals(events, attemptStart, attemptEnd);
        if (!events.length || !completeEvents(events, task.seq)) { available = false; intervals.complete = false; }
      } catch {
        available = false;
      }
      if (!available) warnings.push(`节点 ${node.id} 的 attempt ${attempt.id} 数据缺失、损坏或归属不匹配，成本只累计可读取部分。`);
      intervals.complete &&= Number.isFinite(parsedStart);
      if (!intervals.complete) warnings.push(`attempt ${attempt.id} 的执行时间不完整；未闭合执行段只计至最后事件，不把中断间隔当作执行时间。`);
      dataComplete &&= available;
      timeComplete &&= intervals.complete;
      allActive.push(...intervals.active); allWaiting.push(...intervals.waiting);
      const isCurrent = attempt.id === node.currentAttemptId;
      for (const key of Object.keys(cost) as Array<keyof WorkflowCost>) {
        total[key] += cost[key];
        if (isCurrent) current[key] += cost[key];
      }
      attempts.push({
        id: attempt.id, taskId: attempt.taskId, current: isCurrent, status: attempt.status, taskStatus,
        provider: attempt.provider, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
        invalidatedAt: attempt.invalidatedAt, error: attempt.error,
        dataComplete: available, cost, timing: timing(attemptStart, attemptEnd, intervals.active, intervals.waiting, intervals.complete)
      });
    }
    nodes.push({ id: node.id, status: node.status, attempts });
  }
  const countEvents = (type: string): number => workflowEvents.filter(event => event.type === type).length;
  const requests = { input: countEvents('node.waiting_input'), acceptance: countEvents('node.waiting_acceptance'), total: 0 };
  requests.total = requests.input + requests.acceptance;
  const actions = {
    answers: countEvents('node.input_received'),
    acceptances: workflowEvents.filter(event => event.type === 'node.reviewed' && event.data.decision === 'accepted').length,
    rejections: workflowEvents.filter(event => event.type === 'node.reviewed' && event.data.decision === 'rejected').length,
    retries: workflowEvents.filter(event => event.type === 'workflow.reworked' && event.data.retry === true).length,
    reworks: workflowEvents.filter(event => event.type === 'workflow.reworked' && event.data.retry !== true).length,
    total: 0
  };
  actions.total = actions.answers + actions.acceptances + actions.rejections + actions.retries + actions.reworks;
  return {
    version: 1, runId: run.id, name: run.definition.name, status: run.status, error: run.error, createdAt: run.createdAt,
    generatedAt, observedUntil: new Date(end).toISOString(), nodes, warnings,
    summary: {
      succeededNodes: run.nodes.filter(node => node.status === 'succeeded').length, totalNodes: run.nodes.length,
      totalAttempts: nodes.reduce((sum, node) => sum + node.attempts.length, 0),
      invalidatedAttempts: nodes.flatMap(node => node.attempts).filter(attempt => attempt.status === 'invalidated').length,
      dataComplete, current, total, timing: timing(start, end, allActive, allWaiting, timeComplete && dataComplete),
      human: { requests, actions }
    }
  };
}
