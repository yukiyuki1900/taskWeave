import { skillContext } from '../skills/index.ts';
import { assertHandoff } from '../workflow/handoff.ts';
import { finalizeSummary } from '../agent/summary.ts';
import { verifyArtifacts } from '../artifacts/verify.ts';
import { assertWorkflowTask } from '../workflow/attempt-guard.ts';
import { randomUUID } from 'node:crypto';
import { configHash, DEFAULT_VALIDATION, parseConfig, parseValidationPolicy } from '../config/index.ts';
import { runChecks } from '../validation/checks.ts';
import type { StateStore, RuntimeServices } from '../ports/index.ts';
import { errorMessage, TaskWeaveError } from '../types.ts';
import type { RuntimeConfig, Task, TaskEvent, ValidationItem } from '../types.ts';

export interface ValidationOptions { signal?: AbortSignal; onEvent?: (event: TaskEvent) => void }

export function bindConfig(task: Task, config: RuntimeConfig): void {
  const hash = configHash(config);
  if (task.executionConfigHash && task.executionConfigHash !== hash) throw new TaskWeaveError('CONFIG_MISMATCH', '验证配置与创建任务时不同；请恢复原配置，或创建新任务');
  task.executionConfigHash = hash;
  task.validationPolicy = parseValidationPolicy(task.validationPolicy ?? config.validation[task.kind] ?? DEFAULT_VALIDATION);
  if (task.validationPolicy.checks.some(name => !Object.hasOwn(config.checks, name))) throw new TaskWeaveError('CHECK_NOT_ALLOWED', '任务引用了未配置的验证命令');
}

/** Caller holds the workspace lock. Persist generated answer BEFORE entering this stage. */
export async function validateLocked(services: RuntimeServices, task: Task, store: StateStore, config: RuntimeConfig, options: ValidationOptions = {}): Promise<Task> {
  await assertWorkflowTask(store, task);
  bindConfig(task, config);
  await skillContext(services.workspace(store.workspace), config, task.skills);
  await assertHandoff(store, services.workspace(store.workspace), task);
  if (!task.answer?.trim()) throw new TaskWeaveError('NO_GENERATED_RESULT', '任务尚无最终回答，请先 run / resume');
  const signal = options.signal ?? new AbortController().signal;
  const emit = async (type: string, data: Record<string, unknown> = {}): Promise<void> => {
    const event = await store.emit(task, type, data);
    options.onEvent?.(event);
  };
  if (task.validation?.status !== 'running') {
    if (task.validation) task.validationHistory = [...(task.validationHistory ?? []), task.validation].slice(-20);
    task.validation = { id: `val_${randomUUID()}`, startedAt: new Date().toISOString(), status: 'running', items: [] };
  }
  task.status = 'validating';
  delete task.approval;
  delete task.error;
  await emit('validation.started', { validationId: task.validation.id });
  const items: ValidationItem[] = [{ name: 'output.present', passed: true, detail: '已保存模型最终回答；不代表内容已验收' }];
  const policy = task.validationPolicy!;
  if (policy.checks.length) {
    const results = await runChecks(policy.checks, { runner: services.checkRunner, store, taskId: task.id, key: `validation:${task.validation.id}`, config, signal });
    for (const check of results) {
      items.push({ name: `check:${check.name}`, passed: check.status === 'passed', detail: check.status, check });
    }
  }
  const workspace = services.workspace(store.workspace);
  // Check after commands as well: validation commands may have modified an artifact.
  items.push(...await verifyArtifacts(workspace, task.artifacts, signal));
  for (const [index, rule] of policy.rules.entries()) {
    signal.throwIfAborted();
    try {
      const file = await workspace.read(rule.path);
      let passed = true;
      if (rule.type === 'contains') passed = file.content.includes(rule.text);
      if (rule.type === 'json_fields') {
        const data: unknown = JSON.parse(file.content);
        passed = Boolean(data && typeof data === 'object' && !Array.isArray(data) && rule.fields.every(field => Object.hasOwn(data, field)));
      }
      items.push({ name: `rule:${index}:${rule.type}:${rule.path}`, passed, detail: passed ? `sha256:${file.hash}` : '未满足配置的文件内容规则' });
    } catch (error) { items.push({ name: `rule:${index}:${rule.type}:${rule.path}`, passed: false, detail: errorMessage(error) }); }
  }
  signal.throwIfAborted();
  await skillContext(workspace, config, task.skills);
  await assertHandoff(store, workspace, task);
  task.validation.items = items;
  task.validation.status = items.every(item => item.passed) ? 'passed' : 'failed';
  task.validation.finishedAt = new Date().toISOString();
  task.status = task.validation.status === 'failed' ? 'validation_failed' : policy.requireApproval ? 'waiting_acceptance' : 'completed';
  const summary = await finalizeSummary(task, workspace);
  await emit('summary.generated', { summaryId: summary.id, kind: summary.kind, validationId: task.validation.id });
  // Persist the result and resulting task state together, before any terminal event callback.
  await emit(`validation.${task.validation.status}`, { validationId: task.validation.id, passed: items.filter(item => item.passed).length, total: items.length });
  await emit(`task.${task.status}`, { validationId: task.validation.id, usage: task.usage, artifactCount: task.artifacts.length, childTaskCount: task.childTaskIds.length });
  return task;
}

/** Validation / human acceptance does not require a model key or a model request. */
export class TaskReviewer {
  readonly config: RuntimeConfig;
  constructor(readonly services: RuntimeServices, readonly store: StateStore, config: RuntimeConfig = parseConfig({ version: 1 })) { this.config = parseConfig(config); }

  async validate(id: string, options: ValidationOptions = {}): Promise<Task> {
    return this.store.withLock(async () => {
      const task = await this.store.load(id);
      if (task.workflow) throw new TaskWeaveError('WORKFLOW_MANAGED_TASK', '工作流任务请使用 workflow 命令');
      if (task.status === 'completed' || task.pendingCalls.length || task.awaitingInput) throw new TaskWeaveError('INVALID_REVIEW_STATE', '当前状态不能重新验证');
      bindConfig(task, this.config);
      if (!task.answer?.trim()) throw new TaskWeaveError('NO_GENERATED_RESULT', '任务尚无最终回答，请先 run / resume');
      try { return await validateLocked(this.services, task, this.store, this.config, options); }
      catch (error) {
        task.status = options.signal?.aborted ? 'cancelled' : 'failed';
        task.error = errorMessage(error);
        await this.store.emit(task, `task.${task.status}`, { message: task.error });
        return task;
      }
    });
  }

  async review(id: string, decision: 'accepted' | 'rejected', note: string, options: ValidationOptions = {}): Promise<Task> {
    return this.store.withLock(async () => {
      if ((await this.store.load(id)).workflow) throw new TaskWeaveError('WORKFLOW_MANAGED_TASK', '工作流任务请使用 workflow accept / reject');
      return this.reviewLocked(id, decision, note, options);
    });
  }

  async reviewLocked(id: string, decision: 'accepted' | 'rejected', note: string, options: ValidationOptions = {}): Promise<Task> {
    this.store.assertLocked();
    if (!note.trim() || note.length > 4_000) throw new TaskWeaveError('INVALID_REVIEW', '验收备注必须非空且最多 4,000 字符');
    if (!['accepted', 'rejected'].includes(decision)) throw new TaskWeaveError('INVALID_REVIEW', '无效验收决定');
    const task = await this.store.load(id);
    await assertWorkflowTask(this.store, task);
    bindConfig(task, this.config);
    if (task.status !== 'waiting_acceptance' || task.validation?.status !== 'passed') throw new TaskWeaveError('INVALID_REVIEW_STATE', '任务尚未通过检查或不在等待验收状态');
    if (decision === 'accepted') {
      // Fresh commands + hash checks prevent accepting changed artifacts using stale evidence.
      try {
        const checked = await validateLocked(this.services, task, this.store, this.config, options);
        if (checked.status === 'validation_failed') return checked;
      } catch (error) {
        task.status = options.signal?.aborted ? 'cancelled' : 'failed';
        task.error = errorMessage(error);
        await this.store.emit(task, `task.${task.status}`, { message: task.error });
        return task;
      }
    }
    task.approval = { decision, note: note.trim(), time: new Date().toISOString(), validationId: task.validation!.id };
    task.status = decision === 'accepted' ? 'completed' : 'validation_failed';
    await this.store.emit(task, 'acceptance.recorded', { ...task.approval });
    await this.store.emit(task, `task.${task.status}`, { decision });
    return task;
  }
}
