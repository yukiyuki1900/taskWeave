import { TaskWeaveError } from '../errors.ts';
import type { StateStore, CheckRunner } from '../ports/index.ts';
import type { CheckResult, RuntimeConfig } from '../types.ts';

interface CheckRecord { state: 'started' | 'finished'; result?: CheckResult }
export interface CheckOptions { store: StateStore; runner: CheckRunner; taskId: string; key: string; config: RuntimeConfig; signal: AbortSignal }

/** An interrupted started record is deliberately NOT rerun: command side effects may already exist. */
export async function runCheck(name: string, options: CheckOptions): Promise<CheckResult> {
  if (!Object.hasOwn(options.config.checks, name)) throw new TaskWeaveError('CHECK_NOT_ALLOWED', `未配置验证命令：${name}`);
  const spec = options.config.checks[name];
  const key = `${options.key}:${name}`;
  const record = await options.store.checkRecord<CheckRecord>(options.taskId, key);
  if (record?.state === 'finished' && record.result) return record.result;
  if (record) return { name, status: 'unknown', exitCode: null, stdout: '', stderr: '', durationMs: 0, error: '上次执行结果未知，不会自动重跑；请核实副作用后发起新的验证' };
  const prepared = await options.runner.prepare(name, spec, options.store.workspace);
  options.signal.throwIfAborted();
  await options.store.saveCheckRecord(options.taskId, key, { state: 'started' });
  const result = await prepared.run(options.signal);
  await options.store.saveCheckRecord(options.taskId, key, { state: 'finished', result });
  return result;
}

export async function runChecks(names: string[], options: CheckOptions): Promise<CheckResult[]> {
  if (!names.length || names.length > 30 || names.some(name => !Object.hasOwn(options.config.checks, name))) throw new TaskWeaveError('CHECK_NOT_ALLOWED', '只能选择 1 到 30 个已配置验证命令');
  const results: CheckResult[] = [];
  for (const name of new Set(names)) {
    options.signal.throwIfAborted();
    results.push(await runCheck(name, options));
  }
  return results;
}
