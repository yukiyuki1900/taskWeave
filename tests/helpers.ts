import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { TaskStore } from '@taskweave/adapters';
import type { Message, ModelProvider, ModelTurn, ToolCall } from '@taskweave/core/types';

export async function fixture(t: TestContext): Promise<TaskStore> {
  const directory = path.join(process.cwd(), '.cache');
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, 'test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return TaskStore.open(root);
}

export function tool(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

export function turn(...calls: ToolCall[]): ModelTurn {
  return { content: calls.length ? null : '任务已完成', toolCalls: calls, usage: { input: 10, output: 5 } };
}

type Step = (messages: Message[], signal: AbortSignal) => ModelTurn | Promise<ModelTurn>;
export class ScriptedProvider implements ModelProvider {
  readonly id = 'fixture:v1';
  private index = 0;
  constructor(private steps: Step[]) {}
  complete(messages: Message[], _tools: unknown, signal: AbortSignal): Promise<ModelTurn> {
    const step = this.steps[this.index++];
    if (!step) return Promise.reject(new Error('Unexpected additional model call'));
    return Promise.resolve().then(() => step(messages, signal));
  }
}
