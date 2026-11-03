import { localServices } from '@taskweave/adapters';
import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseConfig } from '@taskweave/core';
import { TaskEngine } from '@taskweave/core';
import { Workspace } from '@taskweave/adapters';
import { TaskReviewer } from '@taskweave/core';
import { executeTool } from '@taskweave/core';
import { parseWorkflow } from '@taskweave/core';
import { loadWorkflow } from '@taskweave/adapters';
import { applyTaskResult, currentAttempt, WorkflowEngine } from '@taskweave/core';
import type { WorkflowNodeDefinition } from '@taskweave/contracts';
import type { ModelProvider } from '@taskweave/core/types';
import { fixture, ScriptedProvider, tool, turn } from '../helpers.ts';

function definition(manual = false) {
  return parseWorkflow({ version: 1, name: 'delivery', nodes: [
    { id: 'requirements', kind: 'requirements', goal: '整理需求', validationPolicy: { rules: [{ type: 'exists', path: 'requirements.md' }], requireApproval: manual } },
    { id: 'code', kind: 'code', goal: '实现', dependsOn: ['requirements'], validationPolicy: { rules: [{ type: 'exists', path: 'code.md' }], requireApproval: false } },
    { id: 'docs', kind: 'document', goal: '写文档', dependsOn: ['code'], validationPolicy: { rules: [{ type: 'exists', path: 'docs.md' }], requireApproval: false } }
  ] });
}
function provider(node: WorkflowNodeDefinition): ModelProvider {
  return new ScriptedProvider([
    messages => {
      if (node.id !== 'requirements') assert.match(messages.find(message => message.role === 'user')!.content!, /已验收/);
      return turn(tool('write_file', { path: `${node.id}.md`, content: `result:${node.id}`, expected_sha256: null }));
    }, () => turn()
  ]);
}

test('workflow definitions reject duplicate nodes, cycles, missing dependencies and invalid policies', () => {
  const node = { id: 'a', kind: 'code', goal: 'goal' };
  for (const nodes of [[node, node], [{ ...node, dependsOn: ['missing'] }], [{ ...node, dependsOn: ['a'] }], [{ ...node, dependsOn: ['b'] }, { ...node, id: 'b', dependsOn: ['a'] }], [{ ...node, validationPolicy: { requireApproval: false } }]]) {
    assert.throws(() => parseWorkflow({ version: 1, name: 'invalid', nodes }));
  }
});

test('serial scheduling releases dependencies and persists correlated tasks, events and input versions', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, provider);
  const run = await engine.create(definition());
  const result = await engine.run(run.id);
  assert.equal(result.status, 'completed');
  assert.ok(result.nodes.every(node => node.status === 'succeeded' && node.attempts.length === 1));
  assert.deepEqual(result.nodes[1].attempts[0].sourceAttempts, [{ nodeId: 'requirements', attemptId: result.nodes[0].currentAttemptId }]);
  assert.equal((await store.list()).length, 3);
  const events = await store.workflowEvents(run.id);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
  assert.deepEqual(events.filter(event => event.type === 'node.started').map(event => event.data.nodeId), ['requirements', 'code', 'docs']);
  const source = await store.load(result.nodes[0].attempts[0].taskId);
  assert.equal(source.workflow?.attemptId, result.nodes[0].currentAttemptId);
  assert.equal((await engine.run(run.id)).nodes[0].attempts.length, 1);
});

test('manual acceptance blocks downstream execution then automatically continues the workflow', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, provider);
  const run = await engine.create(definition(true));
  const waiting = await engine.run(run.id);
  assert.equal(waiting.status, 'waiting_acceptance');
  assert.equal((await store.list()).length, 1);
  assert.equal(waiting.nodes[1].status, 'blocked');
  const attempt = currentAttempt(waiting.nodes[0])!;
  await assert.rejects(engine.review(run.id, 'requirements', 'old-attempt', 'accepted', '已核对'), /过期/);
  const complete = await engine.review(run.id, 'requirements', attempt.id, 'accepted', '已核对范围');
  assert.equal(complete.status, 'completed');
  assert.equal((await store.load(attempt.taskId)).approval?.note, '已核对范围');
});

test('rejection requires an explicit retry which creates fresh task, attempt and receipt identities', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, provider);
  const run = await engine.create(definition(true));
  const first = await engine.run(run.id);
  const old = currentAttempt(first.nodes[0])!;
  const rejected = await engine.review(run.id, 'requirements', old.id, 'rejected', '需要补充异常场景');
  assert.equal(rejected.status, 'failed');
  assert.equal((await engine.run(run.id)).nodes[0].attempts.length, 1);
  await engine.rework(run.id, 'requirements', old.id, '按验收意见重做', true);
  const retry = await engine.run(run.id);
  const next = currentAttempt(retry.nodes[0])!;
  assert.equal(retry.status, 'waiting_acceptance');
  assert.notEqual(next.id, old.id); assert.notEqual(next.taskId, old.taskId);
  assert.equal(retry.nodes[0].attempts[0].status, 'invalidated');
  assert.equal(next.number, 2);
});

test('upstream rework invalidates transitive descendants, preserves unrelated branches and rejects stale results and writes', async t => {
  const store = await fixture(t);
  const spec = definition();
  spec.nodes.push({ ...spec.nodes[2], id: 'independent', dependsOn: [], validationPolicy: { rules: [{ type: 'exists', path: 'independent.md' }], checks: [], requireApproval: false } });
  const independentProvider = (node: WorkflowNodeDefinition): ModelProvider => new ScriptedProvider([() => turn(tool('write_file', { path: `${node.id}.md`, content: `result:${node.id}`, expected_sha256: null })), () => turn()]);
  const engine = new WorkflowEngine(localServices, store, independentProvider);
  const complete = await engine.run((await engine.create(spec)).id);
  const oldAttempt = currentAttempt(complete.nodes[0])!;
  const oldTask = await store.load(oldAttempt.taskId);
  const independentId = complete.nodes[3].currentAttemptId;
  const invalidated = await engine.rework(complete.id, 'requirements', oldAttempt.id, '需求范围变更');
  assert.ok(invalidated.nodes.slice(0, 3).every(node => node.currentAttemptId === undefined && node.attempts[0].status === 'invalidated'));
  assert.equal(invalidated.nodes[3].currentAttemptId, independentId);
  assert.equal(invalidated.nodes[3].status, 'succeeded');
  assert.throws(() => applyTaskResult(invalidated, 'requirements', oldAttempt.id, oldTask), /过期/);
  await store.withLock(async () => {
    await assert.rejects(new TaskEngine(localServices, store, independentProvider(spec.nodes[0])).runLocked(oldTask.id), /过期/);
    const result = await executeTool('write_file', JSON.stringify({ path: 'late.md', content: 'late', expected_sha256: null }), { task: oldTask, store, services: localServices, workspace: new Workspace(store.workspace), callKey: 'late', signal: new AbortController().signal });
    assert.equal(result.error?.code, 'STALE_ATTEMPT');
    await assert.rejects(new TaskReviewer(localServices, store).reviewLocked(oldTask.id, 'accepted', '迟到验收'), /过期/);
  });
  await assert.rejects(readFile(path.join(store.workspace, 'late.md')), { code: 'ENOENT' });
  const rerun = await engine.run(complete.id);
  assert.equal(rerun.status, 'completed');
  assert.equal(rerun.nodes[0].attempts.length, 2);
  assert.equal(rerun.nodes[3].attempts.length, 1);
  assert.notEqual(rerun.nodes[0].currentAttemptId, oldAttempt.id);
});

test('crash after attempt identity checkpoint recreates exactly one deterministic task', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, provider);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const run = await engine.create(spec);
  const interrupted = await engine.run(run.id, { onEvent: event => { if (event.type === 'node.started') throw new Error('simulate coordinator crash'); } });
  assert.equal(interrupted.status, 'failed');
  const savedId = currentAttempt(interrupted.nodes[0])!.taskId;
  assert.equal((await store.list()).length, 0);
  const resumed = await new WorkflowEngine(localServices, store, provider).run(run.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.nodes[0].attempts.length, 1);
  assert.equal(currentAttempt(resumed.nodes[0])!.taskId, savedId);
  assert.equal((await store.list()).length, 1);
});

test('recovery adopts a completed task without another provider call', async t => {
  const store = await fixture(t);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const engine = new WorkflowEngine(localServices, store, provider);
  const run = await engine.run((await engine.create(spec)).id);
  await store.withLock(async () => {
    run.status = 'running'; run.nodes[0].status = 'running'; currentAttempt(run.nodes[0])!.status = 'running';
    await store.saveWorkflow(run);
  });
  const recovered = await new WorkflowEngine(localServices, store, () => { throw new Error('must not recall model'); }).run(run.id);
  assert.equal(recovered.status, 'completed');
  assert.equal((await store.list()).length, 1);
});

test('waiting for input persists the answer and resumes the same attempt', async t => {
  const store = await fixture(t);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const interactive: ModelProvider = {
    id: 'interactive:v1',
    async complete(messages) {
      const answers = messages.filter(message => message.role === 'tool');
      if (!answers.length) return turn(tool('ask_user', { question: '范围是什么？' }));
      if (answers.length === 1) { assert.match(answers[0].content!, /单团队/); return turn(tool('write_file', { path: 'requirements.md', content: '单团队', expected_sha256: null })); }
      return turn();
    }
  };
  const engine = new WorkflowEngine(localServices, store, () => interactive);
  const run = await engine.run((await engine.create(spec)).id);
  assert.equal(run.status, 'waiting_input');
  const attempt = currentAttempt(run.nodes[0])!;
  const done = await engine.answer(run.id, 'requirements', attempt.id, '单团队');
  assert.equal(done.status, 'completed');
  assert.equal(done.nodes[0].attempts.length, 1);
  assert.equal(currentAttempt(done.nodes[0])!.pendingAnswer, undefined);
});

test('cancellation can resume the same checkpoint and concurrent coordinators cannot acquire the lock', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, provider);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const run = await engine.create(spec);
  const controller = new AbortController();
  const cancelled = await engine.run(run.id, { signal: controller.signal, onEvent: event => { if (event.type === 'node.started') controller.abort(); } });
  assert.equal(cancelled.status, 'cancelled');
  const attemptId = cancelled.nodes[0].currentAttemptId;
  assert.equal((await engine.run(run.id)).status, 'completed');
  assert.equal((await store.loadWorkflow(run.id)).nodes[0].currentAttemptId, attemptId);
  await store.withLock(async () => { await assert.rejects(engine.run(run.id), /已有执行器/); });
  await assert.rejects(new TaskEngine(localServices, store, provider(spec.nodes[0])).runLocked(currentAttempt(cancelled.nodes[0])!.taskId), /工作区锁/);
});

test('managed tasks cannot bypass workflow controls; hidden state and configuration remain authoritative', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, provider);
  const run = await engine.run((await engine.create(definition(true))).id);
  const taskId = currentAttempt(run.nodes[0])!.taskId;
  await assert.rejects(new TaskEngine(localServices, store, provider(run.definition.nodes[0])).run(taskId), /工作流任务/);
  await assert.rejects(new TaskReviewer(localServices, store).review(taskId, 'accepted', '绕过'), /工作流任务/);
  await assert.rejects(new TaskReviewer(localServices, store).validate(taskId), /工作流任务/);
  const config = parseConfig({ version: 1, checks: { changed: { command: 'node' } } });
  await assert.rejects(new WorkflowEngine(localServices, store, provider, config).run(run.id), /配置与创建时不同/);
  assert.equal((await store.loadWorkflow(run.id)).status, 'waiting_acceptance');
});

test('torn workflow event tails are repaired and cross-workflow results cannot be adopted', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, provider);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const a = await engine.run((await engine.create(spec)).id);
  const b = await engine.run((await engine.create(spec)).id);
  const otherTask = await store.load(currentAttempt(b.nodes[0])!.taskId);
  assert.throws(() => applyTaskResult(a, 'requirements', a.nodes[0].currentAttemptId!, otherTask), /不属于当前执行/);
  await store.withLock(async () => {
    await appendFile(path.join(store.directory, 'workflows', `${a.id}.jsonl`), '{"seq":999');
    await store.emitWorkflow(a, 'recovered');
  });
  const events = await store.workflowEvents(a.id);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
});

test('a persisted pending answer survives coordinator interruption without being inserted twice', async t => {
  const store = await fixture(t);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const interactive: ModelProvider = { id: 'input-recovery:v1', async complete(messages) {
    const replies = messages.filter(message => message.role === 'tool');
    if (!replies.length) return turn(tool('ask_user', { question: '确认范围？' }));
    if (replies.length === 1) return turn(tool('write_file', { path: 'requirements.md', content: 'done', expected_sha256: null }));
    return turn();
  } };
  const engine = new WorkflowEngine(localServices, store, () => interactive);
  const run = await engine.run((await engine.create(spec)).id);
  const attemptId = run.nodes[0].currentAttemptId!;
  await assert.rejects(engine.answer(run.id, 'requirements', attemptId, '范围已确认', { onEvent: event => { if (event.type === 'node.input_received') throw new Error('input checkpoint crash'); } }), /input checkpoint/);
  const recovered = await engine.run(run.id);
  assert.equal(recovered.status, 'completed');
  const task = await store.load(currentAttempt(recovered.nodes[0])!.taskId);
  assert.equal(task.messages.filter(message => message.tool_call_id === 'ask_user').length, 1);
});

test('model failures stop scheduling and explicit retry starts a new attempt', async t => {
  const store = await fixture(t);
  let calls = 0;
  const engine = new WorkflowEngine(localServices, store, node => ++calls === 1 ? new ScriptedProvider([() => { throw new Error('model offline'); }]) : provider(node));
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const failed = await engine.run((await engine.create(spec)).id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.nodes[0].status, 'failed');
  assert.equal((await engine.run(failed.id)).status, 'failed');
  assert.equal(calls, 1);
  await engine.rework(failed.id, 'requirements', failed.nodes[0].currentAttemptId!, '模型连接恢复', true);
  const done = await engine.run(failed.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.nodes[0].attempts.length, 2);
});

test('workflow deadlines retain recoverable checkpoints and do not appear as success', async t => {
  const store = await fixture(t);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const slow: ModelProvider = { id: 'slow:v1', complete(_messages, _tools, signal) {
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } };
  const engine = new WorkflowEngine(localServices, store, () => slow);
  const timer = setTimeout(() => undefined, 100);
  t.after(() => clearTimeout(timer));
  const failed = await engine.run((await engine.create(spec)).id, { timeoutMs: 30 });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /超过时限/);
  assert.equal(failed.nodes[0].attempts.length, 1);
});

test('managed nodes hide and reject unscheduled child tasks', async t => {
  const store = await fixture(t);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const managed: ModelProvider = { id: 'managed:v1', async complete(messages, tools) {
    assert.equal(tools.some(tool => tool.function.name === 'create_task'), false);
    const replies = messages.filter(message => message.role === 'tool');
    if (!replies.length) return turn(tool('create_task', { title: 'bypass', kind: 'code', goal: 'bypass', acceptance_criteria: ['x'] }));
    if (replies.length === 1) {
      assert.equal(JSON.parse(replies[0].content!).error.code, 'WORKFLOW_MANAGED_TASK');
      return turn(tool('write_file', { path: 'requirements.md', content: 'done', expected_sha256: null }));
    }
    return turn();
  } };
  const engine = new WorkflowEngine(localServices, store, () => managed);
  assert.equal((await engine.run((await engine.create(spec)).id)).status, 'completed');
  assert.equal((await store.list()).length, 1);
});

test('late progress or tool calls cannot overwrite a completed node even with the same attempt ID', async t => {
  const store = await fixture(t);
  const spec = definition(); spec.nodes = spec.nodes.slice(0, 1);
  const engine = new WorkflowEngine(localServices, store, provider);
  const run = await engine.run((await engine.create(spec)).id);
  const attempt = currentAttempt(run.nodes[0])!;
  const task = await store.load(attempt.taskId);
  assert.throws(() => applyTaskResult(run, 'requirements', attempt.id, { ...task, status: 'running' }), /不属于当前执行/);
  await store.withLock(async () => {
    const result = await executeTool('write_file', JSON.stringify({ path: 'late.md', content: 'late', expected_sha256: null }), { task, store, services: localServices, workspace: new Workspace(store.workspace), callKey: 'late-same-attempt', signal: new AbortController().signal });
    assert.equal(result.error?.code, 'STALE_ATTEMPT');
  });
  await assert.rejects(readFile(path.join(store.workspace, 'late.md')), { code: 'ENOENT' });
});

test('async work that outlives a lock cannot reuse the expired lock context', async t => {
  const store = await fixture(t);
  let check: Promise<void> | undefined;
  await store.withLock(async () => {
    check = new Promise(resolve => setTimeout(() => {
      assert.throws(() => store.assertLocked(), /工作区锁/);
      resolve();
    }, 10));
  });
  await check;
});

test('delivery example runs its real configured checks between requirement and document acceptance', async t => {
  const store = await fixture(t);
  const spec = await loadWorkflow('examples/workflows/delivery.json');
  const config = parseConfig(JSON.parse(await readFile('examples/workflows/config.json', 'utf8')));
  const files: Record<string, { path: string; content: string }> = {
    requirements: { path: 'artifacts/requirements.json', content: '{"scope":"strings","stories":[],"rules":[],"acceptance":[]}' },
    implementation: { path: 'src/normalize-title.mjs', content: 'export const normalizeTitle = value => value.trim().replace(/\\s+/g, " ");\n' },
    tests: { path: 'tests/normalize-title.test.mjs', content: 'import test from "node:test";import assert from "node:assert/strict";import {normalizeTitle} from "../src/normalize-title.mjs";test("normalize",()=>assert.equal(normalizeTitle(" a  b "),"a b"));\n' },
    documentation: { path: 'README.md', content: '## 使用说明\nnormalizeTitle\n## 验证结果\nnode --test tests/normalize-title.test.mjs\n' }
  };
  const engine = new WorkflowEngine(localServices, store, node => new ScriptedProvider([
    () => turn(tool('write_file', { ...files[node.id], expected_sha256: null })), () => turn()
  ]), config);
  let run = await engine.run((await engine.create(spec)).id);
  assert.equal(run.status, 'waiting_acceptance');
  run = await engine.review(run.id, 'requirements', run.nodes[0].currentAttemptId!, 'accepted', '需求已核对');
  assert.equal(run.nodes[1].status, 'succeeded');
  assert.equal(run.nodes[2].status, 'succeeded');
  assert.equal(run.nodes[3].status, 'waiting_acceptance');
  for (const node of run.nodes.slice(1, 3)) {
    const task = await store.load(currentAttempt(node)!.taskId);
    assert.equal(task.validation!.items.find(item => item.check)?.check?.exitCode, 0);
  }
  assert.equal((await engine.review(run.id, 'documentation', run.nodes[3].currentAttemptId!, 'accepted', '文档已核对')).status, 'completed');
});
