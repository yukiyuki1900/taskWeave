import { randomUUID } from 'node:crypto';
import { sha256 } from '../hash.ts';
import { TaskWeaveError } from '../errors.ts';
import type { Task, TaskSummary, SummaryEvidence, SummaryStatement } from '../types.ts';
import type { WorkspacePort } from '../ports/index.ts';

const invalid = (): never => { throw new TaskWeaveError('INVALID_SUMMARY', '摘要需包含四组语句，每组最多 8 条；每条 text 最多 600 字符，且必须引用 goal、artifact(path,sha256) 或已完成的 tool(call_id) 证据'); };
const groups = ['facts', 'decisions', 'constraints', 'open_questions'] as const;

/** Evidence references establish provenance, not the semantic truth of a model claim. */
export async function recordSummary(task: Task, args: Record<string, unknown>, workspace: WorkspacePort): Promise<TaskSummary> {
  if (JSON.stringify(args).length > 12_000) return invalid();
  let count = task.messages.length - 1;
  while (count >= 0 && task.messages[count].role !== 'assistant') count--;
  if (count < 2) return invalid();
  const statements: SummaryStatement[][] = [];
  for (const key of groups) {
    const values = args[key];
    if (!Array.isArray(values) || values.length > 8) return invalid();
    const list: SummaryStatement[] = [];
    for (const value of values) {
      if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['text', 'evidence'].includes(key)) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 600 || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 5) return invalid();
      const evidence: SummaryEvidence[] = [];
      for (const ref of value.evidence) {
        if (!ref || typeof ref !== 'object') return invalid();
        if (ref.kind === 'goal' && Object.keys(ref).length === 1) evidence.push({ kind: 'goal', sha256: sha256(task.goal) });
        else if (ref.kind === 'artifact' && Object.keys(ref).every(key => ['kind', 'path', 'sha256'].includes(key)) && typeof ref.path === 'string' && typeof ref.sha256 === 'string') {
          const artifact = task.artifacts.find(file => file.path === ref.path && file.sha256 === ref.sha256);
          if (!artifact || (await workspace.read(ref.path)).hash !== ref.sha256) throw new TaskWeaveError('STALE_SUMMARY_EVIDENCE', '摘要引用的产物不属于当前任务或 hash 已变化');
          evidence.push({ kind: 'artifact', path: ref.path, sha256: ref.sha256 });
        } else if (ref.kind === 'tool' && Object.keys(ref).length === 2 && typeof ref.call_id === 'string') {
          let index = count - 1;
          while (index >= 0 && !(task.messages[index].role === 'tool' && task.messages[index].tool_call_id === ref.call_id)) index--;
          if (index < 2) throw new TaskWeaveError('INVALID_SUMMARY_EVIDENCE', '摘要只能引用当前轮之前已经完成的工具结果');
          evidence.push({ kind: 'tool', callId: ref.call_id, messageIndex: index, sha256: sha256(JSON.stringify(task.messages[index])) });
        } else return invalid();
      }
      list.push({ text: value.text.trim(), evidence });
    }
    statements.push(list);
  }
  return {
    version: 1, id: `sum_${randomUUID()}`, kind: 'model', status: 'valid', updatedAt: new Date().toISOString(),
    sourceMessageCount: count, sourceHash: sha256(JSON.stringify(task.messages.slice(0, count))), goal: task.goal.slice(0, 1_000),
    facts: statements[0], decisions: statements[1], constraints: statements[2], openQuestions: statements[3], artifacts: []
  };
}

export function installSummary(task: Task, summary: TaskSummary): void {
  if (task.summary?.id === summary.id) return;
  if (task.summary) task.summaryHistory = [...(task.summaryHistory ?? []), task.summary].slice(-5);
  task.summary = summary;
}

export async function summaryValid(task: Task, summary: TaskSummary, workspace: Pick<WorkspacePort, 'read'>): Promise<boolean> {
  if (summary.status !== 'valid' || summary.sourceMessageCount > task.messages.length || summary.sourceHash !== sha256(JSON.stringify(task.messages.slice(0, summary.sourceMessageCount)))) return false;
  const statements = [...summary.facts, ...summary.decisions, ...summary.constraints, ...summary.openQuestions, ...(summary.outcome ? [summary.outcome] : [])];
  try {
    for (const statement of statements) for (const ref of statement.evidence) {
      if (ref.kind === 'goal' && ref.sha256 !== sha256(task.goal)) return false;
      if (ref.kind === 'answer' && ref.sha256 !== sha256(task.answer ?? '')) return false;
      if (ref.kind === 'artifact' && (await workspace.read(ref.path)).hash !== ref.sha256) return false;
      if (ref.kind === 'tool' && (ref.messageIndex >= summary.sourceMessageCount || task.messages[ref.messageIndex]?.role !== 'tool' || sha256(JSON.stringify(task.messages[ref.messageIndex])) !== ref.sha256)) return false;
    }
    for (const artifact of summary.artifacts) if ((await workspace.read(artifact.path)).hash !== artifact.sha256) return false;
  } catch { return false; }
  return true;
}

/** Deterministic fallback is explicitly extractive; no invented decisions or facts. */
export async function finalizeSummary(task: Task, workspace: WorkspacePort): Promise<TaskSummary> {
  const previous = task.summary;
  const retained = previous?.kind === 'model' && await summaryValid(task, previous, workspace);
  if (previous && !retained && previous.status === 'valid') { previous.status = 'stale'; previous.staleReason = '证据已变化或重新提取'; }
  const summary: TaskSummary = retained ? structuredClone(previous) : {
    version: 1, id: `sum_${randomUUID()}`, kind: 'extractive', status: 'valid', updatedAt: new Date().toISOString(),
    sourceMessageCount: task.messages.length, sourceHash: sha256(JSON.stringify(task.messages)), goal: task.goal.slice(0, 1_000),
    facts: [], decisions: [], constraints: [], openQuestions: [], artifacts: []
  };
  summary.updatedAt = new Date().toISOString();
  summary.outcome = { text: (task.answer ?? '').slice(0, 1_000), evidence: [{ kind: 'answer', sha256: sha256(task.answer ?? '') }] };
  if (task.artifacts.length > 100) throw new TaskWeaveError('SUMMARY_LIMIT', '摘要最多索引 100 个产物，请拆分任务');
  summary.artifacts = structuredClone(task.artifacts);
  if (task.validation) summary.validation = { id: task.validation.id, status: task.validation.status, items: task.validation.items.map(item => ({ name: item.name, passed: item.passed })) };
  installSummary(task, summary);
  // A retained summary has the same identity; refresh runtime-derived outcome and validation.
  task.summary = summary;
  return summary;
}
