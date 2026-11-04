import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkflow, readWorkflowReport } from '@taskweave/core';
import type { Task, TaskEvent, WorkflowAttempt, WorkflowEvent, WorkflowRun } from '@taskweave/core/types';

const at = (ms: number): string => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
function task(attempt: WorkflowAttempt, events: TaskEvent[], input = 12): Task {
  return {
    version: 1, id: attempt.taskId, kind: 'requirements', title: 'requirements', goal: '需求',
    status: 'completed', provider: 'fixture', workspace: 'fixture', createdAt: attempt.startedAt, updatedAt: at(1100),
    seq: events.length, steps: 2, maxSteps: 24, messages: [], pendingCalls: [], artifacts: [], childTaskIds: [], acceptanceCriteria: [],
    usage: { input, output: 3 }, workflow: { runId: 'wf_report', nodeId: 'requirements', attemptId: attempt.id }
  };
}
function setup() {
  const attempt: WorkflowAttempt = { id: 'att_current', taskId: 'tw_current', number: 1, status: 'succeeded', provider: 'fixture', sourceAttempts: [], artifacts: [], startedAt: at(100), finishedAt: at(1100) };
  const run: WorkflowRun = {
    version: 1, id: 'wf_report', workspace: 'fixture', definition: parseWorkflow({ version: 1, name: 'report', nodes: [{ id: 'requirements', kind: 'requirements', goal: '需求' }] }),
    executionConfigHash: 'fixture', status: 'completed', createdAt: at(0), updatedAt: at(1200), seq: 5,
    nodes: [{ id: 'requirements', status: 'succeeded', currentAttemptId: attempt.id, attempts: [attempt] }]
  };
  const events: TaskEvent[] = [
    ['task.created', 100], ['task.started', 100], ['model.started', 120], ['tool.started', 180], ['tool.failed', 210],
    ['task.waiting_acceptance', 300], ['validation.started', 800], ['task.waiting_acceptance', 900],
    ['acceptance.recorded', 900], ['task.completed', 910]
  ].map(([type, time], index) => ({ taskId: attempt.taskId, seq: index + 1, type: String(type), time: at(Number(time)), data: {} }));
  const workflowEvents: WorkflowEvent[] = [
    { runId: run.id, seq: 1, type: 'workflow.created', time: at(0), data: {} },
    { runId: run.id, seq: 2, type: 'workflow.resumed', time: at(50), data: {} },
    { runId: run.id, seq: 3, type: 'node.waiting_acceptance', time: at(310), data: { nodeId: 'requirements', attemptId: attempt.id } },
    { runId: run.id, seq: 4, type: 'node.reviewed', time: at(920), data: { decision: 'accepted' } },
    { runId: run.id, seq: 5, type: 'workflow.completed', time: at(1200), data: {} }
  ];
  const tasks = new Map([[attempt.taskId, task(attempt, events)]]);
  const taskEvents = new Map([[attempt.taskId, events]]);
  const store = {
    async loadWorkflow() { return structuredClone(run); },
    async workflowEvents() { return structuredClone(workflowEvents); },
    async load(id: string) { const value = tasks.get(id); if (!value) throw new Error('missing task'); return structuredClone(value); },
    async events(id: string) { return structuredClone(taskEvents.get(id) ?? []); }
  };
  return { run, attempt, events, workflowEvents, tasks, taskEvents, store };
}

test('report splits recorded execution, human wait and unobserved time without counting revalidation as another human request', async () => {
  const { store } = setup();
  const report = await readWorkflowReport(store, 'wf_report', at(5000));
  assert.equal(report.status, 'completed');
  assert.equal(report.summary.dataComplete, true);
  assert.deepEqual(report.summary.timing, { elapsedMs: 1200, executionMs: 300, humanWaitMs: 500, unattributedMs: 400, complete: true });
  assert.deepEqual(report.summary.current, { inputTokens: 12, outputTokens: 3, modelCalls: 2, toolCalls: 1, toolFailures: 1 });
  assert.deepEqual(report.summary.total, report.summary.current);
  assert.deepEqual(report.summary.human.requests, { input: 0, acceptance: 1, total: 1 });
  assert.equal(report.summary.human.actions.acceptances, 1);
  assert.equal(report.summary.human.actions.total, 1);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual((await readWorkflowReport(store, 'wf_report', at(10000))).summary, report.summary);
});

test('report includes invalidated attempt cost and failures while keeping current attempt cost separate', async () => {
  const data = setup();
  const old: WorkflowAttempt = { ...data.attempt, id: 'att_old', taskId: 'tw_old', number: 1, status: 'invalidated', startedAt: at(0), finishedAt: at(50), invalidatedAt: at(75), error: '模型服务返回 HTTP 400' };
  data.attempt.number = 2;
  data.run.nodes[0].attempts.unshift(old);
  const events: TaskEvent[] = [
    { taskId: old.taskId, seq: 1, type: 'task.started', time: at(0), data: {} },
    { taskId: old.taskId, seq: 2, type: 'task.failed', time: at(50), data: {} }
  ];
  data.tasks.set(old.taskId, { ...task(old, events, 7), status: 'failed', steps: 1 });
  data.taskEvents.set(old.taskId, events);
  data.workflowEvents.splice(2, 0, { runId: data.run.id, seq: 3, type: 'workflow.reworked', time: at(75), data: { retry: true } });
  data.workflowEvents.forEach((event, index) => { event.seq = index + 1; });
  data.run.seq = 6;
  const report = await readWorkflowReport(data.store, data.run.id, at(5000));
  assert.equal(report.summary.totalAttempts, 2);
  assert.equal(report.summary.invalidatedAttempts, 1);
  assert.equal(report.summary.current.inputTokens, 12);
  assert.equal(report.summary.total.inputTokens, 19);
  assert.equal(report.summary.total.modelCalls, 3);
  assert.equal(report.summary.human.actions.retries, 1);
  assert.equal(report.nodes[0].attempts[0].error, old.error);
  assert.equal(report.nodes[0].attempts[0].current, false);
});

test('report extends an open human wait to observation time and leaves interrupted execution gaps unattributed', async () => {
  const data = setup();
  data.run.status = 'waiting_input'; data.run.nodes[0].status = 'waiting_input';
  data.attempt.status = 'waiting_input'; delete data.attempt.finishedAt;
  const events = data.events.slice(0, 2);
  events.push({ taskId: data.attempt.taskId, seq: 3, type: 'task.waiting_input', time: at(200), data: {} });
  data.taskEvents.set(data.attempt.taskId, events);
  data.tasks.get(data.attempt.taskId)!.status = 'waiting_input';
  data.tasks.get(data.attempt.taskId)!.seq = events.length;
  const waiting = await readWorkflowReport(data.store, data.run.id, at(1000));
  assert.equal(waiting.summary.timing.executionMs, 100);
  assert.equal(waiting.summary.timing.humanWaitMs, 800);
  assert.equal(waiting.summary.timing.complete, true);
  events[2] = { ...events[2], type: 'model.started' };
  data.tasks.get(data.attempt.taskId)!.status = 'running';
  const interrupted = await readWorkflowReport(data.store, data.run.id, at(1000));
  assert.equal(interrupted.summary.timing.executionMs, 100);
  assert.equal(interrupted.summary.timing.humanWaitMs, 0);
  assert.equal(interrupted.summary.timing.unattributedMs, 900);
  assert.equal(interrupted.summary.timing.complete, false);
  assert.ok(interrupted.warnings.some(warning => warning.includes('未闭合执行段')));
});

test('missing or mismatched task records produce partial reports rather than a silent zero-cost success', async () => {
  for (const mismatch of [false, true]) {
    const data = setup();
    if (mismatch) data.tasks.get(data.attempt.taskId)!.workflow!.runId = 'wf_other';
    else data.tasks.clear();
    const report = await readWorkflowReport(data.store, data.run.id, at(5000));
    assert.equal(report.summary.dataComplete, false);
    assert.equal(report.summary.timing.complete, false);
    assert.equal(report.summary.total.inputTokens, 0);
    assert.ok(report.warnings.some(warning => warning.includes('归属不匹配')));
  }
});

test('missing event entries and unreadable workflow logs mark reports incomplete while retaining known usage', async () => {
  const data = setup();
  data.events.splice(3, 1);
  const report = await readWorkflowReport(data.store, data.run.id, at(5000));
  assert.equal(report.summary.total.inputTokens, 12);
  assert.equal(report.summary.dataComplete, false);
  assert.equal(report.summary.timing.complete, false);
  const unreadable = await readWorkflowReport({ ...data.store, async workflowEvents() { throw new Error('unreadable log'); } }, data.run.id, at(5000));
  assert.equal(unreadable.summary.dataComplete, false);
  assert.ok(unreadable.warnings.some(warning => warning.includes('工作流事件不可读取')));
});

test('a resumed invocation does not count the gap after a crash as execution', async () => {
  const data = setup();
  const events: TaskEvent[] = [
    ['task.started', 100], ['model.started', 200], ['task.started', 800], ['task.completed', 900]
  ].map(([type, time], index) => ({ taskId: data.attempt.taskId, seq: index + 1, type: String(type), time: at(Number(time)), data: {} }));
  data.taskEvents.set(data.attempt.taskId, events);
  data.tasks.get(data.attempt.taskId)!.seq = events.length;
  const report = await readWorkflowReport(data.store, data.run.id, at(5000));
  assert.equal(report.summary.timing.executionMs, 200);
  assert.equal(report.summary.timing.unattributedMs, 1000);
  assert.equal(report.summary.timing.complete, false);
});

test('overlapping human waits and another node execution are counted once in workflow wall time', async () => {
  const data = setup();
  const other: WorkflowAttempt = { ...data.attempt, id: 'att_other', taskId: 'tw_other', startedAt: at(400), finishedAt: at(600) };
  data.run.nodes.push({ id: 'other', status: 'succeeded', currentAttemptId: other.id, attempts: [other] });
  const events: TaskEvent[] = [
    { taskId: other.taskId, seq: 1, type: 'task.started', time: at(400), data: {} },
    { taskId: other.taskId, seq: 2, type: 'task.completed', time: at(600), data: {} }
  ];
  data.tasks.set(other.taskId, { ...task(other, events), workflow: { runId: data.run.id, nodeId: 'other', attemptId: other.id } });
  data.taskEvents.set(other.taskId, events);
  const report = await readWorkflowReport(data.store, data.run.id, at(5000));
  assert.equal(report.summary.timing.executionMs, 500);
  assert.equal(report.summary.timing.humanWaitMs, 300);
  assert.equal(report.summary.timing.unattributedMs, 400);
});
