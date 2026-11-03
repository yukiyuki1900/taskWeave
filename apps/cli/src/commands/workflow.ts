import { WorkflowEngine, errorMessage, TaskWeaveError } from '@taskweave/core';
import { HELP, printWorkflow } from '../presentation/workflow.ts';
import type { IO } from '../presentation/task.ts';
import { TaskStore, loadConfig, loadWorkflow, providerFor, localServices } from '../bootstrap.ts';
import { parseArgs } from 'node:util';

function integer(value: string | undefined, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TaskWeaveError('INVALID_OPTION', `参数必须为 1 到 ${max} 的整数`);
  return result;
}
export async function workflowMain(argv: string[], io: IO): Promise<number> {
  try {
    const parsed = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
      file: { type: 'string' }, workspace: { type: 'string' }, config: { type: 'string' }, node: { type: 'string' }, attempt: { type: 'string' },
      note: { type: 'string' }, answer: { type: 'string' }, after: { type: 'string' }, timeout: { type: 'string' }, 'max-steps': { type: 'string' },
      demo: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
    } });
    const flags = parsed.values;
    if (flags.help || !parsed.positionals.length) { io.out(HELP); return 0; }
    const [action, id, ...extra] = parsed.positionals;
    const allowed: Record<string, string[]> = {
      create: ['file', 'config'], run: ['file', 'config', 'demo', 'timeout', 'max-steps'], resume: ['config', 'demo', 'timeout', 'max-steps'],
      show: [], list: [], events: ['after'], accept: ['node', 'attempt', 'note', 'config', 'demo', 'timeout', 'max-steps'],
      reject: ['node', 'attempt', 'note', 'config', 'timeout'], answer: ['node', 'attempt', 'answer', 'config', 'demo', 'timeout', 'max-steps'],
      rework: ['node', 'attempt', 'note', 'config'], retry: ['node', 'attempt', 'note', 'config']
    };
    if (!Object.hasOwn(allowed, action) || extra.length) throw new TaskWeaveError('INVALID_COMMAND', '无效工作流命令，查看 workflow --help');
    const needsId = !['create', 'run', 'list'].includes(action);
    if (Boolean(id) !== needsId) throw new TaskWeaveError('INVALID_COMMAND', '工作流 ID 缺失或多余');
    for (const [key, value] of Object.entries(flags)) {
      if (value !== undefined && !['workspace', 'json'].includes(key) && !allowed[action].includes(key)) throw new TaskWeaveError('INVALID_OPTION', `${action} 不支持 --${key}`);
    }
    if (['create', 'run'].includes(action) && !flags.file) throw new TaskWeaveError('INVALID_WORKFLOW', '请提供 --file');
    if (['accept', 'reject', 'rework', 'retry', 'answer'].includes(action) && (!flags.node || !flags.attempt)) throw new TaskWeaveError('INVALID_OPTION', '请提供 --node 和 --attempt');
    if (['accept', 'reject', 'rework', 'retry'].includes(action) && !flags.note?.trim()) throw new TaskWeaveError('INVALID_REVIEW', '请提供 --note');
    if (action === 'answer' && !flags.answer?.trim()) throw new TaskWeaveError('INVALID_ANSWER', '请提供 --answer');
    const store = await TaskStore.open(flags.workspace ?? process.cwd());
    const json = Boolean(flags.json);
    if (action === 'show') { printWorkflow(await store.loadWorkflow(id!), io, json); return 0; }
    if (action === 'list') {
      const runs = await store.listWorkflows();
      if (json) io.out(JSON.stringify(runs, null, 2)); else runs.forEach(run => io.out(`${run.id}  ${run.status}  ${run.definition.name}`));
      return 0;
    }
    if (action === 'events') {
      await store.loadWorkflow(id!);
      const events = await store.workflowEvents(id!, flags.after === undefined || flags.after === '0' ? 0 : integer(flags.after, 1, Number.MAX_SAFE_INTEGER));
      if (json) io.out(JSON.stringify(events, null, 2)); else events.forEach(event => io.out(`${event.seq} ${event.time} ${event.type} ${JSON.stringify(event.data)}`));
      return 0;
    }
    const config = await loadConfig(store.workspace, flags.config);
    const engine = new WorkflowEngine(localServices, store, node => providerFor(node.kind, Boolean(flags.demo)), config);
    if (action === 'create') { printWorkflow(await engine.create(await loadWorkflow(flags.file!)), io, json); return 0; }
    if (action === 'rework' || action === 'retry') {
      printWorkflow(await engine.rework(id!, flags.node!, flags.attempt!, flags.note!, action === 'retry'), io, json); return 0;
    }
    const timeoutMs = integer(flags.timeout, 300, 3600) * 1000;
    const maxSteps = flags['max-steps'] === undefined ? undefined : integer(flags['max-steps'], 24, 200);
    const controller = new AbortController();
    const stop = (): void => controller.abort(new Error('用户取消'));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      const options = { timeoutMs, maxSteps, signal, onEvent: (event: { seq: number; type: string }): void => io.err(`[${event.seq}] ${event.type}`) };
      const run = action === 'run' ? await engine.run((await engine.create(await loadWorkflow(flags.file!))).id, options)
        : action === 'resume' ? await engine.run(id!, options)
        : action === 'answer' ? await engine.answer(id!, flags.node!, flags.attempt!, flags.answer!, options)
        : await engine.review(id!, flags.node!, flags.attempt!, action === 'accept' ? 'accepted' : 'rejected', flags.note!, options);
      printWorkflow(run, io, json);
      return run.status === 'cancelled' ? 130 : run.status === 'failed' ? 1 : 0;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } catch (error) { io.err(`TaskWeave workflow: ${errorMessage(error)}`); return 1; }
}
