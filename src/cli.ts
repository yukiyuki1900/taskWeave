import { parseArgs } from 'node:util';
import { TaskStore } from './store.ts';
import { TaskEngine } from './engine.ts';
import { CompatibleProvider } from './provider.ts';
import { DemoProvider } from './demo.ts';
import { PRESETS } from './presets.ts';
import { errorMessage, isTaskKind, TaskWeaveError } from './types.ts';
import type { Task, TaskEvent } from './types.ts';

const HELP = `TaskWeave · 织程  v0.1.0-alpha.1

任务驱动的 Agent：需求、测试、文档与代码共享执行内核。

用法：
  taskweave run --kind requirements --prompt "设计一个团队待办应用" --workspace ./work
  taskweave run --demo --kind document --prompt "生成说明文档" --workspace ./demo
  taskweave resume <task-id> --workspace ./work [--answer "补充信息"]
  taskweave list --workspace ./work
  taskweave show <task-id> --workspace ./work
  taskweave events <task-id> --workspace ./work [--after 10]
  taskweave unlock --workspace ./work

选项：
  --kind         requirements | tests | document | code | general（默认 general）
  --prompt       任务目标
  --workspace    工作目录（默认当前目录）
  --max-steps    累计模型调用上限（默认 24，最大 200，恢复时可增加）
  --timeout      本次执行时限，秒（默认 300，最大 3600）
  --answer       恢复等待输入的任务
  --demo         使用固定脚本演示，不访问模型
  --json         向 stdout 输出 JSON；执行进度写到 stderr
  --help         显示帮助

模型配置：TASKWEAVE_API_KEY、TASKWEAVE_MODEL、TASKWEAVE_BASE_URL。
Ctrl+C 取消执行并保留检查点。子任务不会自动执行。`;

interface IO { out: (line: string) => void; err: (line: string) => void }
const defaultIO: IO = { out: line => process.stdout.write(line + '\n'), err: line => process.stderr.write(line + '\n') };

function number(value: string | undefined, name: string, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TaskWeaveError('INVALID_OPTION', `${name} 必须在 1 到 ${max} 之间`);
  return result;
}

function present(task: Task): Record<string, unknown> {
  return {
    id: task.id, kind: task.kind, title: task.title, status: task.status, parentId: task.parentId,
    goal: task.goal, acceptanceCriteria: task.acceptanceCriteria, workspace: task.workspace,
    steps: task.steps, maxSteps: task.maxSteps, provider: task.provider,
    artifacts: task.artifacts, childTaskIds: task.childTaskIds, usage: task.usage,
    awaitingInput: task.awaitingInput, answer: task.answer, error: task.error,
    createdAt: task.createdAt, updatedAt: task.updatedAt
  };
}

function printTask(task: Task, io: IO, json: boolean): void {
  if (json) { io.out(JSON.stringify(present(task), null, 2)); return; }
  io.out(`${task.id}  ${task.status}  ${PRESETS[task.kind].label}\n${task.title}`);
  if (task.answer) io.out('\n' + task.answer);
  if (task.awaitingInput) io.out(`\n需要补充：${task.awaitingInput.question}\n使用 resume ${task.id} --answer "你的回答" 恢复。`);
  if (task.artifacts.length) io.out('\n产物：\n' + task.artifacts.map(file => `  ${file.path} (${file.bytes} bytes)`).join('\n'));
  if (task.childTaskIds.length) io.out('\n待查看子任务：\n' + task.childTaskIds.map(id => `  ${id}`).join('\n'));
  io.out(`\n模型调用：${task.steps}/${task.maxSteps}；tokens：${task.usage.input} input / ${task.usage.output} output`);
  if (task.error) io.err(task.error);
}

export async function main(argv: string[], io: IO = defaultIO): Promise<number> {
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      kind: { type: 'string' }, prompt: { type: 'string' }, workspace: { type: 'string' },
      'max-steps': { type: 'string' }, timeout: { type: 'string' }, answer: { type: 'string' }, after: { type: 'string' },
      demo: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }
    } });
    const flags = parsed.values;
    if (flags.help || !parsed.positionals.length) { io.out(HELP); return 0; }
    const [command, id, ...extra] = parsed.positionals;
    if (extra.length || !['run', 'resume', 'list', 'show', 'events', 'unlock'].includes(command)) throw new TaskWeaveError('INVALID_COMMAND', '无效命令，使用 --help 查看用法');
    const needsId = ['resume', 'show', 'events'].includes(command);
    if ((needsId && !id) || (!needsId && id)) throw new TaskWeaveError('INVALID_COMMAND', '任务 ID 参数缺失或多余');
    const allowed: Record<string, string[]> = {
      run: ['kind', 'prompt', 'max-steps', 'timeout', 'demo'], resume: ['answer', 'max-steps', 'timeout', 'demo'],
      list: [], show: [], events: ['after'], unlock: []
    };
    for (const [key, value] of Object.entries(flags)) {
      if (value !== undefined && value !== false && !['workspace', 'json'].includes(key) && !allowed[command].includes(key)) throw new TaskWeaveError('INVALID_OPTION', `${command} 不支持 --${key}`);
    }
    if (command === 'run' && (!flags.prompt?.trim() || !isTaskKind(flags.kind ?? 'general'))) throw new TaskWeaveError('INVALID_TASK', '请提供非空 --prompt 和有效 --kind');
    const store = await TaskStore.open(flags.workspace ?? process.cwd());
    const json = Boolean(flags.json);
    if (command === 'list') {
      const tasks = await store.list();
      if (json) io.out(JSON.stringify(tasks.map(present), null, 2));
      else io.out(tasks.length ? tasks.map(task => `${task.id}  ${task.status.padEnd(16)} ${task.kind.padEnd(12)} ${task.title}`).join('\n') : '还没有任务。使用 run 创建任务。');
      return 0;
    }
    if (command === 'show') { printTask(await store.load(id!), io, json); return 0; }
    if (command === 'events') {
      await store.load(id!);
      const after = flags.after === undefined ? 0 : number(flags.after, '--after', 1, Number.MAX_SAFE_INTEGER);
      const events = await store.events(id!, after);
      if (json) io.out(JSON.stringify(events, null, 2));
      else events.forEach(event => io.out(`${event.seq.toString().padStart(4)} ${event.time} ${event.type} ${JSON.stringify(event.data)}`));
      return 0;
    }
    if (command === 'unlock') { await store.unlock(); io.out(json ? '{"unlocked":true}' : '工作区锁已检查并释放。'); return 0; }
    const oldTask = command === 'resume' ? await store.load(id!) : null;
    const kind = oldTask?.kind ?? (flags.kind ?? 'general');
    if (!isTaskKind(kind)) throw new TaskWeaveError('INVALID_TASK', '无效任务类型');
    const provider = flags.demo ? new DemoProvider(kind) : new CompatibleProvider({
      baseUrl: process.env.TASKWEAVE_BASE_URL || 'https://api.deepseek.com/v1',
      model: process.env.TASKWEAVE_MODEL || 'deepseek-flash',
      apiKey: process.env.TASKWEAVE_API_KEY || ''
    });
    const engine = new TaskEngine(store, provider);
    const maxSteps = number(flags['max-steps'], '--max-steps', oldTask?.maxSteps ?? 24, 200);
    const timeoutMs = number(flags.timeout, '--timeout', 300, 3600) * 1000;
    const task = oldTask ?? await engine.create({ kind, goal: flags.prompt!, maxSteps });
    io.err(`TaskWeave ${task.id}${flags.demo ? ' [离线脚本演示]' : ''}`);
    const controller = new AbortController();
    const stop = (): void => controller.abort(new Error('用户取消'));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const onEvent = (event: TaskEvent): void => io.err(`[${event.seq}] ${event.type}${typeof event.data.name === 'string' ? ` ${event.data.name}` : ''}`);
      const result = await engine.run(task.id, { answer: flags.answer, maxSteps, timeoutMs, signal: controller.signal, onEvent });
      printTask(result, io, json);
      return ['completed', 'waiting_input'].includes(result.status) ? 0 : result.status === 'cancelled' ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } catch (error) {
    io.err(`TaskWeave: ${errorMessage(error)}`);
    return 1;
  }
}
