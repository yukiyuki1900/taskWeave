import type { WorkflowRef, TaskKind, TaskStatus, Artifact, ValidationPolicy, ValidationRun } from '@taskweave/contracts';
import type { Message, ToolCall } from '../agent/protocol.ts';

export interface Task {
  workflow?: WorkflowRef;
  version: 1;
  id: string;
  kind: TaskKind;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  parentId?: string;
  status: TaskStatus;
  provider: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  steps: number;
  maxSteps: number;
  messages: Message[];
  pendingCalls: ToolCall[];
  awaitingInput?: { callId: string; question: string };
  artifacts: Artifact[];
  childTaskIds: string[];
  usage: { input: number; output: number };
  answer?: string;
  error?: string;
  validationPolicy?: ValidationPolicy;
  executionConfigHash?: string;
  validation?: ValidationRun;
  validationHistory?: ValidationRun[];
  approval?: { decision: 'accepted' | 'rejected'; note: string; time: string; validationId: string };
}

export interface TaskInput {
  workflow?: WorkflowRef;
  kind: TaskKind;
  goal: string;
  title?: string;
  acceptanceCriteria?: string[];
  maxSteps?: number;
  validationPolicy?: ValidationPolicy;
  executionConfigHash?: string;
}
