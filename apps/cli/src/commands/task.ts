import { parseArgs } from 'node:util';
import { TaskEngine, TaskReviewer, errorMessage, isTaskKind, TaskWeaveError } from '@taskweave/core';
import type { TaskEvent } from '@taskweave/core/types';
import { evaluate, loadSuite } from '@taskweave/evaluation';
import { TaskStore, loadConfig, providerFor, localServices } from '../bootstrap.ts';
import { HELP, defaultIO, present, printTask, exitStatus } from '../presentation/task.ts';
import type { IO } from '../presentation/task.ts';

function number(value: string | undefined, name: string, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TaskWeaveError('INVALID_OPTION', `${name} 必须在 1 到 ${max} 之间`);
  return result;
}

export async function taskMain(argv: string[], io: IO = defaultIO): Promise<number> {
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      kind: { type: 'string' }, prompt: { type: 'string' }, workspace: { type: 'string' },
      'max-steps': { type: 'string' }, timeout: { type: 'string' }, answer: { type: 'string' }, after: { type: 'string' },
      config: { type: 'string' }, note: { type: 'string' }, suite: { type: 'string' }, limit: { type: 'string' },
      demo: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }
    } });
    const flags = parsed.values;
    if (flags.help || !parsed.positionals.length) { io.out(HELP); return 0; }
    const [command, id, ...extra] = parsed.positionals;
    if (extra.length || !['run', 'resume', 'list', 'show', 'events', 'unlock', 'validate', 'accept', 'reject', 'eval'].includes(command)) throw new TaskWeaveError('INVALID_COMMAND', '无效命令，使用 --help 查看用法');
    const needsId = ['resume', 'show', 'events', 'validate', 'accept', 'reject'].includes(command);
    if ((needsId && !id) || (!needsId && id)) throw new TaskWeaveError('INVALID_COMMAND', '任务 ID 参数缺失或多余');
    const allowed: Record<string, string[]> = {
      run: ['kind', 'prompt', 'max-steps', 'timeout', 'demo', 'config'], resume: ['answer', 'max-steps', 'timeout', 'demo', 'config'],
      list: [], show: [], events: ['after'], unlock: [], validate: ['config', 'timeout'], accept: ['config', 'note', 'timeout'], reject: ['config', 'note'],
      eval: ['suite', 'limit', 'max-steps', 'timeout', 'demo']
    };
    for (const [key, value] of Object.entries(flags)) {
      if (value !== undefined && value !== false && !['workspace', 'json'].includes(key) && !allowed[command].includes(key)) throw new TaskWeaveError('INVALID_OPTION', `${command} 不支持 --${key}`);
    }
    if (command === 'run' && (!flags.prompt?.trim() || !isTaskKind(flags.kind ?? 'general'))) throw new TaskWeaveError('INVALID_TASK', '请提供非空 --prompt 和有效 --kind');
    if (['accept', 'reject'].includes(command) && !flags.note?.trim()) throw new TaskWeaveError('INVALID_REVIEW', '请通过 --note 提供验收或退回依据');
    if (command === 'eval') {
      if (!flags.suite) throw new TaskWeaveError('INVALID_SUITE', '请提供 --suite');
      const suite = await loadSuite(flags.suite);
      // Fail early without creating a report if model configuration is missing.
      providerFor(suite.cases[0].kind, Boolean(flags.demo));
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const report = await evaluate(suite, {
          workspace: flags.workspace ?? '.cache/evaluations', demo: Boolean(flags.demo), provider: kind => providerFor(kind, Boolean(flags.demo)),
          maxSteps: number(flags['max-steps'], '--max-steps', 24, 200), timeoutMs: number(flags.timeout, '--timeout', 300, 3600) * 1000,
          limit: flags.limit === undefined ? undefined : number(flags.limit, '--limit', suite.cases.length, suite.cases.length), signal: controller.signal,
          onCase: result => io.err(`${result.id}: ${result.status}`)
        });
        io.out(JSON.stringify(report, null, 2));
        return controller.signal.aborted ? 130 : report.summary.passed === report.planned ? 0 : 1;
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
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
    const config = await loadConfig(store.workspace, flags.config);
    if (['validate', 'accept', 'reject'].includes(command)) {
      const reviewer = new TaskReviewer(localServices, store, config);
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(number(flags.timeout, '--timeout', 300, 3600) * 1000)]);
        const result = command === 'validate' ? await reviewer.validate(id!, { signal }) : await reviewer.review(id!, command === 'accept' ? 'accepted' : 'rejected', flags.note!, { signal });
        printTask(result, io, json);
        return exitStatus(result);
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
    const oldTask = command === 'resume' ? await store.load(id!) : null;
    const kind = oldTask?.kind ?? (flags.kind ?? 'general');
    if (!isTaskKind(kind)) throw new TaskWeaveError('INVALID_TASK', '无效任务类型');
    const provider = providerFor(kind, Boolean(flags.demo));
    const engine = new TaskEngine(localServices, store, provider, config);
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
      return exitStatus(result);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } catch (error) {
    io.err(`TaskWeave: ${errorMessage(error)}`);
    return 1;
  }
}
