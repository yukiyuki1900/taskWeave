import type { Task, TaskEvent, ToolResult, WorkflowEvent, WorkflowRun } from '../types.ts';

/** Mutations belong to one workspace lock; snapshots, events and receipts keep their v1 encoding. */
export interface StateStore {
  readonly workspace: string;
  withLock<T>(action: () => Promise<T>): Promise<T>;
  assertLocked(): void;
  load(id: string): Promise<Task>;
  list(): Promise<Task[]>;
  save(task: Task): Promise<void>;
  events(id: string, after?: number): Promise<TaskEvent[]>;
  emit(task: Task, type: string, data?: Record<string, unknown>): Promise<TaskEvent>;
  loadWorkflow(id: string): Promise<WorkflowRun>;
  listWorkflows(): Promise<WorkflowRun[]>;
  saveWorkflow(run: WorkflowRun): Promise<void>;
  workflowEvents(id: string, after?: number): Promise<WorkflowEvent[]>;
  emitWorkflow(run: WorkflowRun, type: string, data?: Record<string, unknown>): Promise<WorkflowEvent>;
  receipt(taskId: string, callKey: string): Promise<ToolResult | null>;
  saveReceipt(taskId: string, callKey: string, result: ToolResult): Promise<void>;
  checkRecord<T>(taskId: string, key: string): Promise<T | null>;
  saveCheckRecord(taskId: string, key: string, record: unknown): Promise<void>;
}

/** Observation only: no lock, mutation, receipt or command API is available. */
export type ReadStateStore = Pick<StateStore, 'workspace' | 'load' | 'list' | 'events' | 'loadWorkflow' | 'listWorkflows' | 'workflowEvents'>;
