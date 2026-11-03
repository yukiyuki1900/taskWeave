import assert from 'node:assert/strict';
import test from 'node:test';
import { createTask, currentAttempt, executeTool, parseConfig, runCheck, sha256, TaskWeaveError, WorkflowEngine } from '../src/index.ts';
import type { StateStore, RuntimeServices, WorkspacePort } from '../src/ports/index.ts';
import type { ModelProvider, Task, TaskEvent, ToolResult, WorkflowEvent, WorkflowRun } from '../src/types.ts';

/** A test adapter with detached snapshots: the core must use its ports to persist every change. */
class MemoryStore implements StateStore {
  readonly workspace = 'memory-workspace';
  private locked = false;
  private tasks = new Map<string, Task>();
  private workflows = new Map<string, WorkflowRun>();
  private taskEvents: TaskEvent[] = [];
  private runEvents: WorkflowEvent[] = [];
  private receipts = new Map<string, ToolResult>();
  private checks = new Map<string, unknown>();
  async withLock<T>(action: () => Promise<T>): Promise<T> {
    if (this.locked) throw new TaskWeaveError('WORKSPACE_BUSY', 'busy');
    this.locked = true;
    try { return await action(); } finally { this.locked = false; }
  }
  assertLocked() { if (!this.locked) throw new TaskWeaveError('LOCK_REQUIRED', 'lock required'); }
  private get<T>(map: Map<string, T>, id: string): T {
    if (!map.has(id)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    return structuredClone(map.get(id)!);
  }
  async load(id: string) { return this.get(this.tasks, id); }
  async list() { return structuredClone([...this.tasks.values()]); }
  async save(task: Task) { this.tasks.set(task.id, structuredClone(task)); }
  async events(id: string, after = 0) { return structuredClone(this.taskEvents.filter(event => event.taskId === id && event.seq > after)); }
  async emit(task: Task, type: string, data = {}) {
    const event = { taskId: task.id, seq: ++task.seq, time: new Date().toISOString(), type, data };
    this.taskEvents.push(structuredClone(event)); await this.save(task); return event;
  }
  async loadWorkflow(id: string) { return this.get(this.workflows, id); }
  async listWorkflows() { return structuredClone([...this.workflows.values()]); }
  async saveWorkflow(run: WorkflowRun) { this.assertLocked(); this.workflows.set(run.id, structuredClone(run)); }
  async workflowEvents(id: string, after = 0) { return structuredClone(this.runEvents.filter(event => event.runId === id && event.seq > after)); }
  async emitWorkflow(run: WorkflowRun, type: string, data = {}) {
    const event = { runId: run.id, seq: ++run.seq, time: new Date().toISOString(), type, data };
    this.runEvents.push(structuredClone(event)); await this.saveWorkflow(run); return event;
  }
  async receipt(id: string, key: string) { return structuredClone(this.receipts.get(`${id}:${key}`) ?? null); }
  async saveReceipt(id: string, key: string, result: ToolResult) { this.receipts.set(`${id}:${key}`, structuredClone(result)); }
  async checkRecord<T>(id: string, key: string): Promise<T | null> { return structuredClone((this.checks.get(`${id}:${key}`) as T) ?? null); }
  async saveCheckRecord(id: string, key: string, record: unknown) { this.checks.set(`${id}:${key}`, structuredClone(record)); }
}

function memoryRuntime() {
  const files = new Map<string, string>();
  let checks = 0;
  const workspace: WorkspacePort = {
    root: 'memory-workspace',
    async walk() { return { files: [...files.keys()], truncated: false }; },
    async read(file) {
      if (!files.has(file)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return { content: files.get(file)!, hash: sha256(files.get(file)!) };
    },
    async write(file, content, expectedHash, signal) {
      signal.throwIfAborted();
      const current = files.has(file) ? sha256(files.get(file)!) : null;
      if (current !== expectedHash && current !== sha256(content)) throw new TaskWeaveError('CONTENT_CONFLICT', 'changed');
      files.set(file, content);
      return { artifact: { path: file, sha256: sha256(content), bytes: Buffer.byteLength(content) }, changed: current !== sha256(content) };
    }
  };
  const services: RuntimeServices = {
    workspace: () => workspace,
    checkRunner: { async prepare(name) { return { async run(signal) {
      signal.throwIfAborted(); checks++;
      return { name, status: 'passed', exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
    } }; } }
  };
  return { files, workspace, services, checks: () => checks };
}

function writer(file: string): ModelProvider {
  let called = false;
  return { id: 'memory:v1', async complete() {
    if (called) return { content: '交付完成', toolCalls: [] };
    called = true;
    return { content: null, toolCalls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: '交付内容', expected_sha256: null }) } }] };
  } };
}

test('workflow executes, reviews and invalidates attempts using only injected memory ports', async () => {
  const store = new MemoryStore();
  const runtime = memoryRuntime();
  const config = parseConfig({ version: 1, checks: { verify: { command: 'virtual-check' } }, validation: { document: { checks: ['verify'] } } });
  const engine = new WorkflowEngine(runtime.services, store, node => writer(`${node.id}.md`), config);
  let run = await engine.run((await engine.create({ version: 1, name: 'memory', nodes: [
    { id: 'requirements', kind: 'requirements', goal: '需求' },
    { id: 'document', kind: 'document', goal: '文档', dependsOn: ['requirements'] }
  ] })).id);
  assert.equal(run.status, 'waiting_acceptance');
  assert.equal(runtime.files.has('document.md'), false);
  run = await engine.review(run.id, 'requirements', currentAttempt(run.nodes[0])!.id, 'accepted', '确认需求');
  assert.equal(run.nodes[1].status, 'waiting_acceptance');
  assert.equal(runtime.checks(), 1);
  run = await engine.review(run.id, 'document', currentAttempt(run.nodes[1])!.id, 'accepted', '确认文档');
  assert.equal(run.status, 'completed');
  assert.equal(runtime.checks(), 2, 'acceptance must run fresh checks');
  const oldTask = await store.load(currentAttempt(run.nodes[1])!.taskId);
  await engine.rework(run.id, 'requirements', currentAttempt(run.nodes[0])!.id, '范围变更');
  const result = await store.withLock(() => executeTool('write_file', JSON.stringify({ path: 'late.md', content: 'late', expected_sha256: null }), {
    services: runtime.services, store, task: oldTask, workspace: runtime.workspace, callKey: 'late', signal: new AbortController().signal
  }));
  assert.equal(result.error?.code, 'STALE_ATTEMPT');
  assert.equal(runtime.files.has('late.md'), false);
});

test('task initialization requires the caller lock and preserves deterministic child identity', async () => {
  const store = new MemoryStore();
  const input = { kind: 'tests' as const, goal: '验证验收标准' };
  await assert.rejects(createTask(store, input, 'memory:v1'), /lock required/);
  await store.withLock(async () => {
    const first = await createTask(store, input, 'memory:v1', 'tw_parent', 'step:call');
    const replay = await createTask(store, input, 'memory:v1', 'tw_parent', 'step:call');
    assert.equal(first.id, replay.id);
    assert.equal((await store.list()).length, 1);
    assert.equal(first.messages[0].role, 'system');
    assert.equal((await store.events(first.id)).length, 1);
  });
});

test('command ports preserve prepare-before-start and unknown-outcome recovery ordering', async () => {
  const store = new MemoryStore();
  const config = parseConfig({ version: 1, checks: { verify: { command: 'virtual-check' } } });
  const options = { store, taskId: 'tw_virtual', key: 'validation', config, signal: new AbortController().signal };
  await assert.rejects(runCheck('verify', { ...options, runner: { async prepare() { throw new Error('invalid cwd'); } } }), /invalid cwd/);
  assert.equal(await store.checkRecord(options.taskId, 'validation:verify'), null);
  let executions = 0;
  const runner = { async prepare() { return { async run() {
    assert.deepEqual(await store.checkRecord(options.taskId, 'validation:verify'), { state: 'started' });
    executions++;
    throw new Error('process interrupted');
  } }; } };
  await assert.rejects(runCheck('verify', { ...options, runner }), /interrupted/);
  assert.equal((await runCheck('verify', { ...options, runner })).status, 'unknown');
  assert.equal(executions, 1);
});
