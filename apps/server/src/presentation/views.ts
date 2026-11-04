import { sha256 } from '@taskweave/core';
import type { Task, TaskSummary, SummaryStatement, WorkflowRun } from '@taskweave/core/types';
import type { Artifact, ArtifactView, ProviderMode, TaskListItem, SummaryView, TaskView, ValidationView, WorkflowListItem, WorkflowReport, ReportView } from '@taskweave/contracts';

export function text(value: string | undefined, root: string, max = 4_000): string | undefined {
  return typeof value === 'string' ? value.split(root).join('<workspace>').slice(0, max) : undefined;
}
export function providerMode(provider: string | undefined): ProviderMode { return provider?.startsWith('demo:') ? 'demo' : provider?.startsWith('compatible:') ? 'model' : 'unknown'; }
export function artifactView(taskId: string, artifact: Artifact): ArtifactView {
  return { id: `art_${sha256(`${taskId}\0${artifact.path}\0${artifact.sha256}`).slice(0, 24)}`, path: artifact.path, recordedSha256: artifact.sha256, bytes: artifact.bytes };
}
export function taskItem(task: Task): TaskListItem {
  return {
    id: task.id, title: task.title, kind: task.kind, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt, seq: task.seq,
    ...(task.parentId ? { parentId: task.parentId } : {}),
    ...(task.workflow ? { workflow: { runId: task.workflow.runId, nodeId: task.workflow.nodeId, attemptId: task.workflow.attemptId } } : {}),
    providerMode: providerMode(task.provider), steps: task.steps, maxSteps: task.maxSteps,
    usage: { input: task.usage?.input ?? 0, output: task.usage?.output ?? 0 }, artifactCount: task.artifacts.length
  };
}
export function workflowItem(run: WorkflowRun): WorkflowListItem {
  return { id: run.id, name: run.definition.name, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, seq: run.seq, succeededNodes: run.nodes.filter(node => node.status === 'succeeded').length, totalNodes: run.nodes.length };
}
function statement(value: SummaryStatement, root: string): SummaryView['facts'][number] {
  return { text: text(value.text, root, 1_000)!, evidence: value.evidence.map(ref => ({ kind: ref.kind, sha256: ref.sha256,
    ...(ref.kind === 'artifact' ? { path: ref.path } : {}), ...(ref.kind === 'tool' ? { callId: ref.callId } : {}) })) };
}
export function summaryView(value: TaskSummary, root: string): Omit<SummaryView, 'evidenceCurrent'> {
  return { id: value.id, kind: value.kind, status: value.status, updatedAt: value.updatedAt,
    facts: value.facts.map(item => statement(item, root)), decisions: value.decisions.map(item => statement(item, root)),
    constraints: value.constraints.map(item => statement(item, root)), openQuestions: value.openQuestions.map(item => statement(item, root)),
    ...(value.outcome ? { outcome: statement(value.outcome, root) } : {}) };
}
function validationView(task: Task): ValidationView | null {
  const value = task.validation;
  return value ? { id: value.id, status: value.status, startedAt: value.startedAt, finishedAt: value.finishedAt, items: value.items.map(item => ({
    name: item.name, passed: item.passed, detail: text(item.detail, task.workspace, 2_000)!,
    ...(item.check ? { check: { name: item.check.name, status: item.check.status, exitCode: item.check.exitCode, durationMs: item.check.durationMs } } : {})
  })) } : null;
}
export function taskView(task: Task, evidenceCurrent: boolean, currentAttempt: boolean | null): TaskView {
  return { ...taskItem(task), goal: text(task.goal, task.workspace, 20_000)!, acceptanceCriteria: task.acceptanceCriteria.map(item => text(item, task.workspace, 500)!),
    answer: text(task.answer, task.workspace, 20_000), answerTruncated: (task.answer?.length ?? 0) > 20_000, error: text(task.error, task.workspace), question: text(task.awaitingInput?.question, task.workspace), currentAttempt,
    artifacts: task.artifacts.map(artifact => artifactView(task.id, artifact)), childTaskIds: task.childTaskIds,
    validation: validationView(task), approval: task.approval ? { decision: task.approval.decision, note: text(task.approval.note, task.workspace)!, time: task.approval.time, validationId: task.approval.validationId } : null,
    summary: task.summary ? { ...summaryView(task.summary, task.workspace), evidenceCurrent } : null,
    skills: (task.skills ?? []).map(skill => ({ id: skill.id, description: skill.description, version: skill.version, path: skill.path, sha256: skill.sha256 })),
    handoff: task.handoff ? { runId: task.handoff.runId, nodeId: task.handoff.nodeId, digest: task.handoff.digest, sources: task.handoff.sources.map(source => ({
      nodeId: source.nodeId, attemptId: source.attemptId, taskId: source.taskId, validationId: source.validationId,
      summary: summaryView(source.summary, task.workspace), artifacts: source.artifacts.map(artifact => artifactView(source.taskId, artifact)),
      ...(source.approval ? { approval: { decision: source.approval.decision, time: source.approval.time } } : {})
    })) } : null
  };
}
export function reportView(report: WorkflowReport, root: string): ReportView {
  // Deep projection: adding a field to the internal report must not publish it automatically.
  const cost = (value: WorkflowReport['summary']['total']) => ({ inputTokens: value.inputTokens, outputTokens: value.outputTokens, modelCalls: value.modelCalls, toolCalls: value.toolCalls, toolFailures: value.toolFailures });
  const timing = (value: WorkflowReport['summary']['timing']) => ({ elapsedMs: value.elapsedMs, executionMs: value.executionMs, humanWaitMs: value.humanWaitMs, unattributedMs: value.unattributedMs, complete: value.complete });
  const summary = report.summary;
  return { version: 1, runId: report.runId, name: report.name, status: report.status, error: text(report.error, root), createdAt: report.createdAt, generatedAt: report.generatedAt, observedUntil: report.observedUntil,
    summary: { succeededNodes: summary.succeededNodes, totalNodes: summary.totalNodes, totalAttempts: summary.totalAttempts, invalidatedAttempts: summary.invalidatedAttempts, dataComplete: summary.dataComplete,
      current: cost(summary.current), total: cost(summary.total), timing: timing(summary.timing), human: {
        requests: { input: summary.human.requests.input, acceptance: summary.human.requests.acceptance, total: summary.human.requests.total },
        actions: { answers: summary.human.actions.answers, acceptances: summary.human.actions.acceptances, rejections: summary.human.actions.rejections, retries: summary.human.actions.retries, reworks: summary.human.actions.reworks, total: summary.human.actions.total }
      } }, warnings: report.warnings.map(warning => text(warning, root)!), nodes: report.nodes.map(node => ({ id: node.id, status: node.status, attempts: node.attempts.map(attempt => ({
        id: attempt.id, taskId: attempt.taskId, current: attempt.current, status: attempt.status, taskStatus: attempt.taskStatus, providerMode: providerMode(attempt.provider),
        startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, invalidatedAt: attempt.invalidatedAt, error: text(attempt.error, root), dataComplete: attempt.dataComplete, cost: cost(attempt.cost), timing: timing(attempt.timing)
      })) })) };
}
