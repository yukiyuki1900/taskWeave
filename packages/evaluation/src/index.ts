import { TaskEngine, parseConfig, parseValidationPolicy, errorMessage, isTaskKind, TaskWeaveError } from '@taskweave/core';
import type { ModelProvider, RuntimeConfig, TaskKind, ValidationPolicy } from '@taskweave/core/types';
import { atomicWrite, Workspace, TaskStore, localServices } from '@taskweave/adapters';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface EvaluationCase {
  id: string;
  kind: TaskKind;
  goal: string;
  files: Record<string, string>;
  validation: ValidationPolicy;
}
export interface EvaluationSuite { version: 1; name: string; config: RuntimeConfig; cases: EvaluationCase[] }
export interface CaseResult {
  id: string;
  kind: TaskKind;
  taskId?: string;
  provider: string;
  status: string;
  passed: boolean;
  failure?: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  inputTokens: number;
  outputTokens: number;
  humanInterventions: number;
}
export interface EvaluationReport {
  version: 1;
  suite: string;
  mode: 'demo' | 'model';
  runDirectory: string;
  startedAt: string;
  finishedAt?: string;
  planned: number;
  cases: CaseResult[];
  summary: { executed: number; passed: number; passRate: number; durationMs: number; inputTokens: number; outputTokens: number; toolCalls: number; humanInterventions: number };
}

export function parseSuite(raw: unknown): EvaluationSuite {
  const fail = (): never => { throw new TaskWeaveError('INVALID_SUITE', '评测集无效，请参考 examples/evaluation'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['version', 'name', 'config', 'cases'].includes(key)) || value.version !== 1 || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 100) return fail();
  const config = parseConfig(value.config ?? { version: 1 });
  const seen = new Set<string>();
  const cases: EvaluationCase[] = value.cases.map(rawCase => {
    if (!rawCase || typeof rawCase !== 'object' || Array.isArray(rawCase)) return fail();
    const item = rawCase as Record<string, unknown>;
    if (Object.keys(item).some(key => !['id', 'kind', 'goal', 'files', 'validation'].includes(key)) || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) || seen.has(item.id) || !isTaskKind(item.kind) || typeof item.goal !== 'string' || !item.goal.trim() || item.goal.length > 20_000) return fail();
    seen.add(item.id);
    const files = item.files ?? {};
    if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 30 || Object.values(files).some(content => typeof content !== 'string' || Buffer.byteLength(content) > 200 * 1024)) return fail();
    const validation = parseValidationPolicy(item.validation);
    if (validation.checks.some(name => !Object.hasOwn(config.checks, name))) return fail();
    return { id: item.id, kind: item.kind, goal: item.goal, files: files as Record<string, string>, validation };
  });
  return { version: 1, name: value.name, config, cases };
}

export async function loadSuite(file: string): Promise<EvaluationSuite> {
  const input = await new Workspace(process.cwd()).read(file);
  try { return parseSuite(JSON.parse(input.content)); }
  catch (error) { if (error instanceof TaskWeaveError) throw error; throw new TaskWeaveError('INVALID_SUITE', '评测集不是有效 JSON'); }
}

export interface EvaluationOptions {
  workspace: string;
  demo: boolean;
  provider: (kind: TaskKind) => ModelProvider;
  maxSteps?: number;
  timeoutMs?: number;
  limit?: number;
  signal?: AbortSignal;
  onCase?: (result: CaseResult) => void;
}

export async function evaluate(input: EvaluationSuite, options: EvaluationOptions): Promise<EvaluationReport> {
  const suite = parseSuite(input);
  const limit = options.limit ?? suite.cases.length;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > suite.cases.length) throw new TaskWeaveError('INVALID_LIMIT', '评测数量超出用例范围');
  const root = path.resolve(options.workspace, `eval-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const report: EvaluationReport = {
    version: 1, suite: suite.name, mode: options.demo ? 'demo' : 'model', runDirectory: root,
    startedAt: new Date().toISOString(), planned: limit, cases: [],
    summary: { executed: 0, passed: 0, passRate: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, humanInterventions: 0 }
  };
  const save = async (): Promise<void> => { await atomicWrite(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n'); };
  await save();
  for (const item of suite.cases.slice(0, limit)) {
    if (options.signal?.aborted) break;
    const started = performance.now();
    const result: CaseResult = { id: item.id, kind: item.kind, provider: '', status: 'failed', passed: false, durationMs: 0, modelCalls: 0, toolCalls: 0, toolFailures: 0, inputTokens: 0, outputTokens: 0, humanInterventions: 0 };
    try {
      const store = await TaskStore.open(path.join(root, item.id));
      const workspace = new Workspace(store.workspace);
      for (const [file, content] of Object.entries(item.files)) await atomicWrite(await workspace.resolve(file, true), content, 0o644);
      // Persist exactly the policy used, so users can inspect or resume individual cases.
      await atomicWrite(path.join(store.directory, 'config.json'), JSON.stringify(suite.config, null, 2) + '\n');
      const provider = options.provider(item.kind);
      result.provider = provider.id;
      const engine = new TaskEngine(localServices, store, provider, suite.config);
      const created = await engine.create({ kind: item.kind, goal: item.goal, validationPolicy: item.validation, maxSteps: options.maxSteps });
      result.taskId = created.id;
      const task = await engine.run(created.id, { signal: options.signal, timeoutMs: options.timeoutMs });
      result.status = task.status;
      result.passed = task.status === 'completed' && task.validation?.status === 'passed';
      result.modelCalls = task.steps;
      result.inputTokens = task.usage.input;
      result.outputTokens = task.usage.output;
      const events = await store.events(task.id);
      result.toolCalls = events.filter(event => event.type === 'tool.started').length;
      result.toolFailures = events.filter(event => event.type === 'tool.failed').length;
      result.humanInterventions = events.filter(event => event.type === 'input.requested' || event.type === 'task.waiting_acceptance').length;
      if (!result.passed) result.failure = task.error ?? (task.status === 'validation_failed' ? 'validation' : task.status);
    } catch (error) { result.failure = errorMessage(error); }
    result.durationMs = Math.round(performance.now() - started);
    report.cases.push(result);
    report.summary = {
      executed: report.cases.length, passed: report.cases.filter(item => item.passed).length,
      passRate: report.cases.filter(item => item.passed).length / report.cases.length,
      durationMs: report.cases.reduce((sum, item) => sum + item.durationMs, 0),
      inputTokens: report.cases.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: report.cases.reduce((sum, item) => sum + item.outputTokens, 0),
      toolCalls: report.cases.reduce((sum, item) => sum + item.toolCalls, 0),
      humanInterventions: report.cases.reduce((sum, item) => sum + item.humanInterventions, 0)
    };
    await save();
    options.onCase?.(result);
  }
  report.finishedAt = new Date().toISOString();
  await save();
  return report;
}
