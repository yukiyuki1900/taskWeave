import { sha256 } from '../hash.ts';
import { TaskWeaveError } from '../errors.ts';
import { finalizeSummary, summaryValid } from '../agent/summary.ts';
import type { ContextHandoff, Task, WorkflowRun } from '../types.ts';
import type { StateStore, WorkspacePort } from '../ports/index.ts';

const digest = (handoff: Omit<ContextHandoff, 'digest'>): string => sha256(JSON.stringify(handoff));
const fail = (): never => { throw new TaskWeaveError('STALE_HANDOFF', '上游交接的 attempt、摘要、验收证据或文件 hash 已变化；请恢复原产物，或通过 workflow rework 重新生成下游 attempt'); };

export async function createHandoff(store: StateStore, workspace: WorkspacePort, run: WorkflowRun, nodeId: string): Promise<ContextHandoff | undefined> {
  const dependencies = run.definition.nodes.find(node => node.id === nodeId)!.dependsOn;
  if (!dependencies.length) return undefined;
  const sources: ContextHandoff['sources'] = [];
  for (const id of dependencies) {
    const node = run.nodes.find(node => node.id === id)!;
    const attempt = node.attempts.find(attempt => attempt.id === node.currentAttemptId);
    if (!attempt || node.status !== 'succeeded') return fail();
    const task = await store.load(attempt.taskId);
    if (task.workflow?.runId !== run.id || task.workflow.nodeId !== id || task.workflow.attemptId !== attempt.id || task.status !== 'completed' || task.validation?.status !== 'passed' || (task.validationPolicy?.requireApproval && task.approval?.decision !== 'accepted')) return fail();
    const summary = task.summary ?? await finalizeSummary(task, workspace);
    if (!await summaryValid(task, summary, workspace)) return fail();
    for (const artifact of task.artifacts) if ((await workspace.read(artifact.path)).hash !== artifact.sha256) return fail();
    sources.push({ nodeId: id, attemptId: attempt.id, taskId: task.id, summary: structuredClone(summary), artifacts: structuredClone(task.artifacts), validationId: task.validation.id,
      ...(task.approval ? { approval: { decision: task.approval.decision, time: task.approval.time } } : {}) });
  }
  const payload = { version: 1 as const, runId: run.id, nodeId, sources };
  if (JSON.stringify(payload).length > 32_000) throw new TaskWeaveError('HANDOFF_LIMIT', '结构化交接超过 32,000 字符，请减少直接依赖或拆分任务；不会截断 JSON');
  return { ...payload, digest: digest(payload) };
}

export async function assertHandoff(store: StateStore, workspace: WorkspacePort, task: Task): Promise<void> {
  const handoff = task.handoff;
  if (!handoff) return; // v0.3 checkpoints keep their original goal and input representation.
  const { digest: expected, ...payload } = handoff;
  if (!task.workflow || handoff.runId !== task.workflow.runId || handoff.nodeId !== task.workflow.nodeId || digest(payload) !== expected) return fail();
  const run = await store.loadWorkflow(handoff.runId);
  const spec = run.definition.nodes.find(node => node.id === handoff.nodeId);
  if (!spec || spec.dependsOn.length !== handoff.sources.length || spec.dependsOn.some(id => !handoff.sources.some(source => source.nodeId === id))) return fail();
  for (const source of handoff.sources) {
    const node = run.nodes.find(node => node.id === source.nodeId);
    const attempt = node?.attempts.find(attempt => attempt.id === node.currentAttemptId);
    if (node?.status !== 'succeeded' || attempt?.id !== source.attemptId || attempt.taskId !== source.taskId) return fail();
    const upstream = await store.load(source.taskId);
    if (upstream.workflow?.runId !== run.id || upstream.workflow.nodeId !== source.nodeId || upstream.workflow.attemptId !== source.attemptId || upstream.status !== 'completed' || upstream.validation?.status !== 'passed' || upstream.validation.id !== source.validationId || (upstream.validationPolicy?.requireApproval && upstream.approval?.decision !== 'accepted')
      || JSON.stringify(upstream.artifacts) !== JSON.stringify(source.artifacts) || !await summaryValid(upstream, source.summary, workspace)) return fail();
    for (const artifact of source.artifacts) if ((await workspace.read(artifact.path)).hash !== artifact.sha256) return fail();
  }
}
