export const TASK_KINDS = ['requirements', 'tests', 'document', 'code', 'general'] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type TaskStatus = 'pending' | 'running' | 'waiting_input' | 'validating' | 'validation_failed' | 'waiting_acceptance' | 'completed' | 'failed' | 'cancelled' | 'budget_exceeded';

export function isTaskKind(value: unknown): value is TaskKind {
  return TASK_KINDS.includes(value as TaskKind);
}
