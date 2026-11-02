import { setTimeout as delay } from 'node:timers/promises';
import { TaskWeaveError } from './types.ts';
import type { Message, ModelProvider, ModelTurn, ToolCall, ToolDefinition } from './types.ts';

export interface ProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskWeaveError('INVALID_MODEL_RESPONSE', '模型返回的数据结构无效');
  return value as Record<string, unknown>;
}

export function parseModelTurn(value: unknown): ModelTurn {
  const response = object(value);
  if (!Array.isArray(response.choices) || !response.choices.length) throw new TaskWeaveError('INVALID_MODEL_RESPONSE', '模型没有返回 choices');
  const choice = object(response.choices[0]);
  if (choice.finish_reason === 'length') throw new TaskWeaveError('MODEL_OUTPUT_LIMIT', '模型输出达到长度上限，本轮没有执行任何工具，可恢复后重试');
  const message = object(choice.message);
  const rawCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawCalls) || rawCalls.length > 16) throw new TaskWeaveError('INVALID_MODEL_RESPONSE', '单轮工具调用数量必须小于等于 16');
  const seen = new Set<string>();
  const toolCalls: ToolCall[] = rawCalls.map(raw => {
    const call = object(raw);
    const fn = object(call.function);
    if (typeof call.id !== 'string' || !call.id || call.id.length > 200 || seen.has(call.id)
      || call.type !== 'function' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string'
      || fn.arguments.length > 220_000) throw new TaskWeaveError('INVALID_MODEL_RESPONSE', '模型返回了无效或重复的工具调用');
    seen.add(call.id);
    return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
  });
  const content = typeof message.content === 'string' ? message.content : null;
  if (!toolCalls.length && !content?.trim()) throw new TaskWeaveError('EMPTY_MODEL_RESPONSE', '模型返回了空回答');
  const usage = response.usage && typeof response.usage === 'object' ? object(response.usage) : {};
  const count = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  return {
    content, toolCalls,
    ...(typeof message.reasoning_content === 'string' ? { reasoningContent: message.reasoning_content } : {}),
    usage: { input: count(usage.prompt_tokens), output: count(usage.completion_tokens) }
  };
}

export class CompatibleProvider implements ModelProvider {
  readonly id: string;
  private endpoint: string;

  constructor(private options: ProviderOptions) {
    const url = new URL(options.baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
      throw new TaskWeaveError('INVALID_PROVIDER_URL', '模型地址必须使用 HTTPS（本地开发地址可用 HTTP），且不能包含凭据或查询参数');
    }
    if (!options.apiKey.trim() || !options.model.trim()) throw new TaskWeaveError('PROVIDER_CONFIG', '请配置 TASKWEAVE_API_KEY 与 TASKWEAVE_MODEL，或使用 --demo');
    this.endpoint = `${url.href.replace(/\/+$/, '')}/chat/completions`;
    this.id = `compatible:${url.origin}${url.pathname.replace(/\/+$/, '')}:${options.model}`;
  }

  async complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal): Promise<ModelTurn> {
    const fetcher = this.options.fetch ?? fetch;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const response = await fetcher(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.options.model, messages, tools, tool_choice: 'auto', stream: false, max_tokens: 4096 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 90_000)])
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const ms = retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 300 * 2 ** attempt;
          await delay(ms, undefined, { signal });
          continue;
        }
        // Never echo upstream bodies: they may contain credentials or private inputs.
        throw new TaskWeaveError('PROVIDER_HTTP', `模型服务返回 HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new TaskWeaveError('INVALID_MODEL_RESPONSE', '模型响应没有正文');
      const buffers: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new TaskWeaveError('MODEL_RESPONSE_TOO_LARGE', '模型响应超过 2 MiB');
          }
          buffers.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      let json;
      try { json = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
      catch { throw new TaskWeaveError('INVALID_MODEL_RESPONSE', '模型返回了无效 JSON'); }
      return parseModelTurn(json);
    }
    throw new TaskWeaveError('PROVIDER_HTTP', '模型请求重试次数耗尽');
  }
}
