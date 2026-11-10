import { createWebHandler } from '@taskweave/server';

/** Optional local static host. A generic HTTP static host can serve the same build. */
export async function createDemoHost(directory: string, origin: string) {
  const app = await createWebHandler(
    async () =>
      Response.json(
        {
          apiVersion: 1,
          observedAt: new Date().toISOString(),
          error: { code: 'NO_LIVE_API', message: '此服务仅托管静态演示' },
        },
        { status: 404 },
      ),
    directory,
    origin,
  );
  return async (request: Request) => {
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      (url.pathname === '/' || url.pathname === '/index.html') &&
      [...url.searchParams.keys()].every((key) => key === 'frame') &&
      url.searchParams.getAll('frame').length === 1 &&
      /^[0-9]{1,2}$/.test(url.searchParams.get('frame')!)
    ) {
      url.search = '';
      return app(new Request(url, { headers: request.headers }));
    }
    return app(request);
  };
}
