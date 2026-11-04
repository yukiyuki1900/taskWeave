/** Classify a bounded error body without exposing provider text or request data. */
export async function badRequestHint(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16 * 1024) { await reader.cancel(); return ''; }
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || !('error' in value)) return '';
    const error = value.error;
    if (!error || typeof error !== 'object') return '';
    const fields = error as Record<string, unknown>;
    const description = [fields.message, fields.param, fields.code].filter(field => typeof field === 'string').join(' ').toLowerCase();
    if (description.includes('reasoning_content')) return '服务端提示 reasoning_content 不符合要求，请检查思考内容是否在后续工具调用请求中完整回传';
    if (/tool_calls|tool_call_id/.test(description)) return '服务端提示工具调用历史不符合要求，请检查调用 ID 与工具结果的配对及顺序';
    if (/max_tokens|max_completion_tokens/.test(description)) return '服务端提示输出长度参数不符合要求，请核对模型支持的参数及上下文限制';
    if (/thinking|reasoning_effort/.test(description)) return '服务端提示思考模式参数不符合要求，请核对模型与服务端配置';
    return '';
  } catch {
    signal.throwIfAborted();
    return '';
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
