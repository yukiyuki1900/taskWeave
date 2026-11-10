import type { ApiError, ApiResponse, EventPage, EventView } from '@taskweave/contracts';

export class QueryError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public details?: Record<string, string | number>,
  ) {
    super(message);
  }
}
export type Transport = typeof fetch;
/** Relative same-origin GET only; a static Demo can implement this interface later. */
export class ReadClient {
  constructor(private transport: Transport = (...args) => fetch(...args)) {}
  async get<T>(path: string, signal: AbortSignal): Promise<ApiResponse<T>> {
    if (!path.startsWith('/api/v1/') || /[\\#]/.test(path))
      throw new QueryError('INVALID_ROUTE', '查询路径无效');
    let response: Response;
    try {
      response = await this.transport(path, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new QueryError('OFFLINE', '连接中断或查询超时，请确认本地 Server 仍在运行');
    }
    let body: ApiResponse<T> | ApiError;
    try {
      body = await response.json();
    } catch {
      throw new QueryError(
        'INVALID_RESPONSE',
        '响应不是有效 JSON，请使用支持 Web 的 TaskWeave Server',
      );
    }
    if (!body || body.apiVersion !== 1)
      throw new QueryError('VERSION_MISMATCH', 'API 版本不兼容，请更新本地 Server');
    if ('error' in body)
      throw new QueryError(
        body.error.code,
        body.error.message,
        response.status,
        body.error.details,
      );
    if (!response.ok || !('data' in body) || !body.revision || !Array.isArray(body.warnings))
      throw new QueryError('INVALID_RESPONSE', '查询响应不完整');
    return body;
  }
}
export const client = new ReadClient();
export function mergeEvents(previous: EventView[], page: EventPage): EventView[] {
  const key = (event: EventView) => `${event.scope}:${event.id}:${event.seq}`;
  const events = new Map(previous.map((event) => [key(event), event]));
  for (const event of page.items) events.set(key(event), event);
  return [...events.values()].sort((a, b) => a.seq - b.seq).slice(-1000);
}
