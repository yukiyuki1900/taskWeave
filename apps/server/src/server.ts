import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLocalReadApi } from './bootstrap.ts';

/** The adapter can be exercised with in-memory request/response objects, without listen(). */
export function nodeHandler(api: (request: Request) => Promise<Response>, origin: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      request.resume(); // No API consumes or persists a request body.
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'invalid'}`);
      if (url.origin !== origin) {
        response.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        response.end(JSON.stringify({ apiVersion: 1, observedAt: new Date().toISOString(), error: { code: 'ORIGIN_DENIED', message: '请求来源不匹配' } }));
        return;
      }
      // Preserve Host in the URL so the app rejects DNS rebinding / unexpected virtual hosts.
      const result = await api(new Request(url, { method: request.method === 'GET' ? 'GET' : 'POST', headers }));
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(await result.text());
    } catch {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify({ apiVersion: 1, observedAt: new Date().toISOString(), error: { code: 'INVALID_REQUEST', message: 'HTTP 请求无效' } }));
    }
  };
}

export interface ServerOptions { workspace: string; port?: number; name?: string }
export async function serve(options: ServerOptions) {
  const port = options.port ?? 4310;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port 必须在 1 到 65535 之间');
  const origin = `http://127.0.0.1:${port}`;
  const api = await createLocalReadApi(options.workspace, { origin, name: options.name });
  const handler = nodeHandler(api, origin);
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => { void handler(request, response); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, origin };
}
