import type { Message, ModelTurn, ToolDefinition } from '../agent/protocol.ts';

export interface ModelProvider {
  readonly id: string;
  complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<ModelTurn>;
}
