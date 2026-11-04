import { randomUUID } from 'node:crypto';
import { sha256 } from '../hash.ts';
import { hasCode, isTaskKind, TaskWeaveError } from '../types.ts';
import type { Task, TaskInput } from './types.ts';
import type { StateStore } from '../ports/index.ts';
import { systemPrompt } from '../presets/index.ts';
import { DEFAULT_VALIDATION, parseValidationPolicy } from '../config/index.ts';
import { workflowTaskId } from '../workflow/definition.ts';

const now = (): string => new Date().toISOString();

/** The caller holds the same lock used for tool side effects and checkpoints. */
export async function createTask(store: StateStore, input: TaskInput, provider: string, parentId?: string, callKey?: string): Promise<Task> {
  store.assertLocked();
  if (!isTaskKind(input.kind) || !input.goal.trim() || input.goal.length > 20_000) throw new TaskWeaveError('INVALID_TASK', '任务类型或目标无效（目标最多 20,000 字符）');
  const maxSteps = input.maxSteps ?? 24;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) throw new TaskWeaveError('INVALID_BUDGET', 'maxSteps 必须在 1 到 200 之间');
  const id = input.workflow ? workflowTaskId(input.workflow) : callKey && parentId ? `tw_${sha256(`${parentId}:${callKey}`).slice(0, 24)}` : `tw_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  if (callKey || input.workflow) {
    try { return await store.load(id); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
  const task: Task = {
    version: 1, id, kind: input.kind,
    ...(input.workflow ? { workflow: { ...input.workflow } } : {}),
    ...(input.boundSkills?.length ? { skills: input.boundSkills } : {}),
    ...(input.handoff ? { handoff: input.handoff } : {}),
    ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
    title: input.title?.trim().slice(0, 160) || input.goal.trim().slice(0, 80),
    goal: input.goal.trim(), acceptanceCriteria: input.acceptanceCriteria ?? [],
    validationPolicy: parseValidationPolicy(input.validationPolicy ?? DEFAULT_VALIDATION),
    ...(input.executionConfigHash ? { executionConfigHash: input.executionConfigHash } : {}),
    ...(parentId ? { parentId } : {}),
    status: 'pending', provider, workspace: store.workspace,
    createdAt: now(), updatedAt: now(), seq: 0, steps: 0, maxSteps,
    messages: [{ role: 'system', content: systemPrompt(input) }, { role: 'user', content: input.goal.trim() }],
    pendingCalls: [], artifacts: [], childTaskIds: [], usage: { input: 0, output: 0 }
  };
  await store.emit(task, 'task.created', { kind: task.kind, title: task.title });
  return task;
}
