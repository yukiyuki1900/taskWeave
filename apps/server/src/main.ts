import { parseArgs } from 'node:util';
import { serve } from './server.ts';

export const HELP = `TaskWeave read-only Server（v0.5）
用法：taskweave-server --workspace <已有工作区> [--port 4310] [--name TaskWeave] [--web apps/web/dist]
仅监听 127.0.0.1；只读 /api/v1，可通过 --web 托管已构建 Web，不提供执行控制。
不创建工作区、不调用模型、不加载验证命令或密钥。`;
export interface ServerIO { out: (message: string) => void; err: (message: string) => void }
export async function main(argv: string[], io: ServerIO = { out: message => process.stdout.write(message + '\n'), err: message => process.stderr.write(message + '\n') }): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      workspace: { type: 'string' }, port: { type: 'string' }, name: { type: 'string' }, web: { type: 'string' }, help: { type: 'boolean', short: 'h' }
    } });
    if (values.help) { io.out(HELP); return 0; }
    if (!values.workspace?.trim()) { io.err('请通过 --workspace 指定已有 TaskWeave 工作区'); return 1; }
    if (values.port !== undefined && !/^[1-9][0-9]{0,4}$/.test(values.port)) { io.err('--port 必须在 1 到 65535 之间'); return 1; }
    if (values.name !== undefined && (!values.name.trim() || values.name.length > 160)) { io.err('--name 必须为 1 到 160 字符'); return 1; }
    if (values.web !== undefined && !values.web.trim()) { io.err('--web 必须指定已构建 Web 目录'); return 1; }
    const { server, origin } = await serve({ workspace: values.workspace, port: values.port === undefined ? undefined : Number(values.port), name: values.name, web: values.web });
    const stop = (): void => { server.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    server.once('close', () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
    io.out(`TaskWeave 只读 API：${origin}/api/v1/workspace`);
    if (values.web) io.out(`TaskWeave Web：${origin}/#/workflows`);
    return 0;
  } catch { io.err('TaskWeave Server 启动失败：请检查参数、已有工作区、Web 构建目录、读取权限及端口。'); return 1; }
}
