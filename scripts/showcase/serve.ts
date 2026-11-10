import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { nodeHandler } from '@taskweave/server';
import { createDemoHost } from './host.ts';

const { values } = parseArgs({
  options: { port: { type: 'string' }, dir: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help)
  console.log(
    'npm run showcase:serve -- [--port 4311] [--dir apps/web/dist-demo]\n仅托管静态 Demo，不读取工作区、不提供 API、不调用模型。',
  );
else {
  const port = Number(values.port ?? 4311);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('port 必须在 1 到 65535 之间');
  const origin = `http://127.0.0.1:${port}`;
  const app = await createDemoHost(values.dir ?? 'apps/web/dist-demo', origin);
  const handler = nodeHandler(app, origin);
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void handler(request, response);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on('error', () => {
    console.error('静态演示启动失败，请检查本地端口。');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`TaskWeave 静态演示：${origin}/`));
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}
