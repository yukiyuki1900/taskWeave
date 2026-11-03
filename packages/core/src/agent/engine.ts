import { assertWorkflowTask } from '../workflow/attempt-guard.ts';
import { createTask } from '../task/create.ts';
import { buildContext } from '../agent/context.ts';
import type { StateStore, RuntimeServices } from '../ports/index.ts';
import { argumentObject, availableTools, executeTool } from '../tools/index.ts';
import { configHash, DEFAULT_VALIDATION, parseConfig } from '../config/index.ts';
import { bindConfig, validateLocked } from '../validation/index.ts';
import { errorMessage, TaskWeaveError } from '../types.ts';
import type { Artifact, ModelProvider, RuntimeConfig, Task, TaskEvent, TaskInput, ToolResult } from '../types.ts';

export interface RunOptions {
  answer?: string;
  maxSteps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: TaskEvent) => void;
}

export class TaskEngine {
  readonly config: RuntimeConfig;
  constructor(readonly services: RuntimeServices, readonly store: StateStore, readonly provider: ModelProvider, config: RuntimeConfig = parseConfig({ version: 1 })) { this.config = parseConfig(config); }

  async create(input: TaskInput): Promise<Task> {
    return this.store.withLock(() => createTask(this.store, { ...input, validationPolicy: input.validationPolicy ?? this.config.validation[input.kind] ?? DEFAULT_VALIDATION, executionConfigHash: configHash(this.config) }, this.provider.id));
  }

  async run(id: string, options: RunOptions = {}): Promise<Task> {
    return this.store.withLock(async () => {
      if ((await this.store.load(id)).workflow) throw new TaskWeaveError('WORKFLOW_MANAGED_TASK', '工作流任务请使用 workflow resume / answer / accept / rework');
      return this.runLocked(id, options);
    });
  }

  /** Internal workflow entry; the same store must hold the workspace lock. */
  async runLocked(id: string, options: RunOptions = {}): Promise<Task> {
    this.store.assertLocked();
    const task = await this.store.load(id);
    await assertWorkflowTask(this.store, task, true);
    if (task.provider !== this.provider.id) throw new TaskWeaveError('PROVIDER_MISMATCH', '恢复任务必须使用创建任务时的模型配置（demo 任务需 --demo）');
    if (task.status === 'completed') throw new TaskWeaveError('TASK_COMPLETED', '任务已完成，无需重复执行');
    if (task.status === 'waiting_acceptance') throw new TaskWeaveError('ACCEPTANCE_REQUIRED', '任务等待验收，请使用 accept / reject');
    bindConfig(task, this.config);
    if (task.status === 'waiting_input' && options.answer === undefined) throw new TaskWeaveError('ANSWER_REQUIRED', '任务正在等待输入，请通过 --answer 提供回答');
    if (options.answer !== undefined && !task.awaitingInput) throw new TaskWeaveError('UNEXPECTED_ANSWER', '当前任务没有待回答的问题');
    if (options.answer !== undefined && (!options.answer.trim() || options.answer.length > 20_000)) throw new TaskWeaveError('INVALID_ANSWER', '回答必须非空且最多 20,000 字符');
    if (options.maxSteps !== undefined) {
      if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < task.steps || options.maxSteps < 1 || options.maxSteps > 200) throw new TaskWeaveError('INVALID_BUDGET', '新步数上限不能小于已用步数，且最大为 200');
      task.maxSteps = options.maxSteps;
    }
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new TaskWeaveError('INVALID_BUDGET', '运行时限必须在 1 ms 到 1 小时之间');
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const emit = async (type: string, data: Record<string, unknown> = {}): Promise<void> => {
      const event = await this.store.emit(task, type, data);
      options.onEvent?.(event);
    };
    const recordResult = (result: ToolResult): void => {
      if (!result.ok || !result.data || typeof result.data !== 'object') return;
      const data = result.data as { artifact?: Artifact; taskId?: string };
      if (data.artifact) task.artifacts = [...task.artifacts.filter(file => file.path !== data.artifact!.path), data.artifact];
      if (data.taskId && !task.childTaskIds.includes(data.taskId)) task.childTaskIds.push(data.taskId);
    };
    try {
      if (task.answer && (task.status === 'validating' || task.validation?.status === 'running')) return await validateLocked(this.services, task, this.store, this.config, { signal, onEvent: options.onEvent });
      if (task.status === 'validation_failed') {
        const failures = task.validation?.items.filter(item => !item.passed).map(item => ({
          name: item.name, detail: item.detail,
          ...(item.check ? { status: item.check.status, exitCode: item.check.exitCode, stdout: item.check.stdout.slice(0, 2_000), stderr: item.check.stderr.slice(0, 2_000), error: item.check.error } : {})
        }));
        const feedback = JSON.stringify({ items: failures, review: task.approval }).slice(0, 20_000);
        task.messages.push({ role: 'user', content: `独立验收未通过，请修正后重新交付。以下为有长度上限的证据摘录；完整结果保存在任务检查点。\n${feedback}` });
        delete task.answer;
        delete task.approval;
      }
      if (task.awaitingInput && options.answer !== undefined) {
        const callId = task.awaitingInput.callId;
        task.messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ ok: true, data: { answer: options.answer } }) });
        task.pendingCalls = task.pendingCalls.filter(call => call.id !== callId);
        delete task.awaitingInput;
        task.status = 'running';
        await emit('input.received', { callId });
      }
      task.status = 'running';
      delete task.error;
      await emit('task.started', { steps: task.steps, maxSteps: task.maxSteps });
      const workspace = this.services.workspace(this.store.workspace);
      while (true) {
        signal.throwIfAborted();
        while (task.pendingCalls.length) {
          signal.throwIfAborted();
          const call = task.pendingCalls[0];
          const callKey = `${task.steps}:${call.id}`;
          if (call.function.name === 'ask_user') {
            let question: unknown;
            try {
              const args = argumentObject(call.function.arguments);
              if (Object.keys(args).length !== 1) throw new Error('参数只能包含 question');
              question = args.question;
              if (typeof question !== 'string' || !question.trim() || question.length > 4_000) throw new Error('question 必须是非空字符串，最多 4,000 字符');
            } catch (error) {
              task.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: errorMessage(error) } }) });
              task.pendingCalls.shift();
              await emit('tool.failed', { name: 'ask_user', callId: call.id, code: 'INVALID_ARGUMENTS' });
              continue;
            }
            task.status = 'waiting_input';
            task.awaitingInput = { callId: call.id, question: question as string };
            await emit('input.requested', { question, callId: call.id });
            return task;
          }
          await emit('tool.started', { name: call.function.name, callId: call.id });
          const cached = await this.store.receipt(task.id, callKey);
          const result = cached ?? await executeTool(call.function.name, call.function.arguments, { services: this.services, task, store: this.store, workspace, callKey, signal, config: this.config });
          // Receipt precedes message checkpoint; replay reuses it after a crash.
          if (!cached) await this.store.saveReceipt(task.id, callKey, result);
          recordResult(result);
          task.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          task.pendingCalls.shift();
          await emit(result.ok ? 'tool.completed' : 'tool.failed', { name: call.function.name, callId: call.id, replayed: Boolean(cached), ...(result.error ? { code: result.error.code } : {}) });
        }
        signal.throwIfAborted();
        if (task.steps >= task.maxSteps) {
          task.status = 'budget_exceeded';
          await emit('task.budget_exceeded', { steps: task.steps });
          return task;
        }
        const context = buildContext(task);
        if (context.archivedRounds) await emit('context.compacted', { archivedRounds: context.archivedRounds });
        task.steps++;
        await emit('model.started', { step: task.steps });
        const turn = await this.provider.complete(context.messages, availableTools(this.config, Boolean(task.workflow)), signal);
        signal.throwIfAborted();
        task.usage.input += turn.usage?.input ?? 0;
        task.usage.output += turn.usage?.output ?? 0;
        task.messages.push({
          role: 'assistant', content: turn.content,
          ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
          ...(turn.reasoningContent ? { reasoning_content: turn.reasoningContent } : {})
        });
        task.pendingCalls = turn.toolCalls;
        if (!turn.toolCalls.length) {
          if (!turn.content?.trim()) throw new TaskWeaveError('EMPTY_MODEL_RESPONSE', '模型返回了空回答');
          task.answer = turn.content;
          task.status = 'validating';
          await emit('task.generated', { artifactCount: task.artifacts.length, childTaskCount: task.childTaskIds.length });
          return await validateLocked(this.services, task, this.store, this.config, { signal, onEvent: options.onEvent });
        }
        await emit('model.completed', { step: task.steps, toolCount: turn.toolCalls.length });
      }
    } catch (error) {
      task.status = signal.aborted && !deadline.aborted ? 'cancelled' : 'failed';
      task.error = deadline.aborted ? '本次执行超过时限；检查点已保留' : signal.aborted ? '本次执行已取消；检查点已保留' : errorMessage(error);
      await emit(`task.${task.status}`, { message: task.error });
      return task;
    }
  }
}
