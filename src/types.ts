export const TASK_KINDS = ['requirements', 'tests', 'document', 'code', 'general'] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type TaskStatus = 'pending' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled' | 'budget_exceeded';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ModelTurn {
  content: string | null;
  toolCalls: ToolCall[];
  reasoningContent?: string;
  usage?: { input: number; output: number };
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ModelProvider {
  readonly id: string;
  complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<ModelTurn>;
}

export interface Artifact { path: string; sha256: string; bytes: number }
export interface TaskEvent {
  taskId: string;
  seq: number;
  time: string;
  type: string;
  data: Record<string, unknown>;
}

export interface Task {
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
}

export interface TaskInput {
  kind: TaskKind;
  goal: string;
  title?: string;
  acceptanceCriteria?: string[];
  maxSteps?: number;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export class TaskWeaveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TaskWeaveError';
  }
}

export function isTaskKind(value: unknown): value is TaskKind {
  return TASK_KINDS.includes(value as TaskKind);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
