export interface TaskEvent {
  taskId: string;
  seq: number;
  time: string;
  type: string;
  data: Record<string, unknown>;
}

export interface WorkflowEvent {
  runId: string;
  seq: number;
  time: string;
  type: string;
  data: Record<string, unknown>;
}
