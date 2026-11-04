import type { TaskStatus } from './task.ts';
import type { WorkflowAttempt, WorkflowNodeStatus, WorkflowStatus } from './workflow.ts';

export interface WorkflowCost {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
}

export interface WorkflowTiming {
  elapsedMs: number;
  executionMs: number;
  humanWaitMs: number;
  unattributedMs: number;
  complete: boolean;
}

export interface WorkflowAttemptReport {
  id: string;
  taskId: string;
  current: boolean;
  status: WorkflowAttempt['status'];
  taskStatus?: TaskStatus;
  provider: string;
  startedAt: string;
  finishedAt?: string;
  invalidatedAt?: string;
  error?: string;
  dataComplete: boolean;
  cost: WorkflowCost;
  timing: WorkflowTiming;
}

export interface WorkflowReport {
  version: 1;
  runId: string;
  name: string;
  status: WorkflowStatus;
  error?: string;
  createdAt: string;
  generatedAt: string;
  observedUntil: string;
  summary: {
    succeededNodes: number;
    totalNodes: number;
    totalAttempts: number;
    invalidatedAttempts: number;
    dataComplete: boolean;
    current: WorkflowCost;
    total: WorkflowCost;
    timing: WorkflowTiming;
    human: {
      requests: { input: number; acceptance: number; total: number };
      actions: { answers: number; acceptances: number; rejections: number; retries: number; reworks: number; total: number };
    };
  };
  nodes: Array<{ id: string; status: WorkflowNodeStatus; attempts: WorkflowAttemptReport[] }>;
  warnings: string[];
}
