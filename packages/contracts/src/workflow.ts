import type { Artifact } from './artifact.ts';
import type { TaskKind } from './task.ts';
import type { ValidationPolicy } from './validation.ts';

export interface WorkflowRef { runId: string; nodeId: string; attemptId: string }
export interface WorkflowNodeDefinition {
  id: string;
  title: string;
  kind: TaskKind;
  goal: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  validationPolicy?: ValidationPolicy;
  maxSteps: number;
}
export interface WorkflowDefinition { version: 1; name: string; nodes: WorkflowNodeDefinition[] }
export type WorkflowStatus = 'pending' | 'running' | 'waiting_input' | 'waiting_acceptance' | 'failed' | 'cancelled' | 'completed';
export type WorkflowNodeStatus = 'blocked' | 'ready' | 'running' | 'waiting_input' | 'waiting_acceptance' | 'succeeded' | 'failed' | 'cancelled';
export interface WorkflowAttempt {
  id: string;
  number: number;
  taskId: string;
  provider: string;
  status: 'running' | 'waiting_input' | 'waiting_acceptance' | 'succeeded' | 'failed' | 'cancelled' | 'invalidated';
  sourceAttempts: Array<{ nodeId: string; attemptId: string }>;
  startedAt: string;
  finishedAt?: string;
  invalidatedAt?: string;
  reason?: string;
  artifacts: Artifact[];
  answer?: string;
  error?: string;
  pendingAnswer?: string;
}
export interface WorkflowNode {
  id: string;
  status: WorkflowNodeStatus;
  currentAttemptId?: string;
  attempts: WorkflowAttempt[];
  reworkNote?: string;
}
export interface WorkflowRun {
  version: 1;
  id: string;
  workspace: string;
  definition: WorkflowDefinition;
  executionConfigHash: string;
  status: WorkflowStatus;
  nodes: WorkflowNode[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
