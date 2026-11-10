import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

type Handler = (request: Request) => Promise<Response>;
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
};

/** Explicit build directory, loaded once at startup. No arbitrary disk path per request. */
export async function createWebHandler(
  api: Handler,
  directory: string,
  origin: string,
): Promise<Handler> {
  const root = path.resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Web 构建目录无效');
  const assets = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
  let total = 0;
  async function collect(folder: string, prefix: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(entry.name))
        throw new Error('Web 文件名不受支持');
      const file = path.join(folder, entry.name);
      const route = `${prefix}/${entry.name}`;
      if (entry.isDirectory() && !prefix && entry.name === 'assets') {
        await collect(file, route);
        continue;
      }
      const extension = path.extname(entry.name);
      const type = types[extension];
      if (!entry.isFile() || !type || (extension === '.html' && route !== '/index.html'))
        throw new Error('Web 构建包含非静态资源');
      if (assets.size >= 200) throw new Error('Web 构建资源过多');
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || total + stat.size > 16 * 1024 * 1024)
          throw new Error('Web 构建资源超限');
        const buffer = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== stat.size) throw new Error('Web 构建资源读取期间变化');
        assets.set(route, {
          body: new Uint8Array(buffer.subarray(0, bytesRead)),
          type,
        });
        total += bytesRead;
      } finally {
        await handle.close();
      }
    }
  }
  await collect(root, '');
  if (!assets.has('/index.html')) throw new Error('请先构建 Web，构建目录缺少 index.html');
  const error = (status: number, message: string) =>
    new Response(message, {
      status,
      headers: {
        ...headers,
        'content-type': 'text/plain; charset=utf-8',
        ...(status === 405 ? { allow: 'GET' } : {}),
      },
    });
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(request);
    if (
      url.origin !== origin ||
      (request.headers.has('origin') && request.headers.get('origin') !== origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return error(403, '只允许同源读取');
    if (request.method !== 'GET') return error(405, '仅支持 GET');
    const asset = assets.get(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!asset || url.search) return error(404, '资源不存在');
    return new Response(asset.body, {
      headers: { ...headers, 'content-type': asset.type },
    });
  };
}
