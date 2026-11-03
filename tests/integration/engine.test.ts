import { localServices } from '@taskweave/adapters';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { TaskReviewer } from '@taskweave/core';
import { TaskEngine } from '@taskweave/core';
import { DemoProvider } from '@taskweave/adapters';
import { Workspace } from '@taskweave/adapters';
import { executeTool } from '@taskweave/core';
import { fixture, ScriptedProvider, tool, turn } from '../helpers.ts';

test('model/tool loop reads source material, writes an artifact and persists ordered events', async t => {
  const store = await fixture(t);
  await writeFile(path.join(store.workspace, 'brief.md'), '负责人必须能更新任务状态。');
  const provider = new ScriptedProvider([
    () => turn(tool('read_file', { path: 'brief.md' })),
    messages => {
      const observation = JSON.parse(messages.at(-1)!.content!);
      assert.match(observation.data.content, /负责人/);
      return turn(tool('write_file', { path: 'artifacts/requirements.md', content: `# 需求\n${observation.data.content}\n`, expected_sha256: null }));
    },
    messages => { assert.equal(JSON.parse(messages.at(-1)!.content!).ok, true); return turn(); }
  ]);
  const engine = new TaskEngine(localServices, store, provider);
  const created = await engine.create({ kind: 'requirements', goal: '基于 brief.md 生成需求' });
  const result = await engine.run(created.id);
  assert.equal(result.status, 'waiting_acceptance');
  assert.equal(result.steps, 3);
  assert.deepEqual(result.usage, { input: 30, output: 15 });
  assert.match(await readFile(path.join(store.workspace, result.artifacts[0].path), 'utf8'), /负责人/);
  assert.equal((await store.load(created.id)).answer, result.answer);
  const events = await store.events(created.id);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.at(-1)!.type, 'task.waiting_acceptance');
});

test('requirements demo produces a document and two pending typed child tasks', async t => {
  const store = await fixture(t);
  const engine = new TaskEngine(localServices, store, new DemoProvider('requirements'));
  const parent = await engine.create({ kind: 'requirements', goal: '团队待办应用' });
  const result = await engine.run(parent.id);
  assert.equal(result.status, 'waiting_acceptance');
  assert.equal(result.artifacts.length, 1);
  const children = await Promise.all(result.childTaskIds.map(id => store.load(id)));
  assert.deepEqual(children.map(child => child.kind), ['code', 'tests']);
  assert.ok(children.every(child => child.status === 'pending' && child.parentId === parent.id && child.acceptanceCriteria.length > 0));
  assert.equal((await store.list()).length, 3);
});

test('a tool error is an observation the model can repair', async t => {
  const store = await fixture(t);
  const provider = new ScriptedProvider([
    () => turn(tool('unknown_tool', {})),
    messages => {
      assert.equal(JSON.parse(messages.at(-1)!.content!).error.code, 'UNKNOWN_TOOL');
      return turn(tool('write_file', { path: 'result.md', content: 'recovered', expected_sha256: null }));
    },
    () => turn()
  ]);
  const engine = new TaskEngine(localServices, store, provider);
  const task = await engine.create({ kind: 'document', goal: '生成文档' });
  assert.equal((await engine.run(task.id)).status, 'waiting_acceptance');
  assert.equal(await readFile(path.join(store.workspace, 'result.md'), 'utf8'), 'recovered');
});

test('ask_user checkpoints the rest of a tool batch and resumes with the answer', async t => {
  const store = await fixture(t);
  const first = new TaskEngine(localServices, store, new ScriptedProvider([
    () => turn(tool('ask_user', { question: '目标用户是谁？' }), tool('write_file', { path: 'after.md', content: '继续执行', expected_sha256: null }))
  ]));
  const task = await first.create({ kind: 'requirements', goal: '整理需求' });
  const waiting = await first.run(task.id);
  assert.equal(waiting.status, 'waiting_input');
  assert.equal(waiting.pendingCalls.length, 2);
  await assert.rejects(readFile(path.join(store.workspace, 'after.md')), { code: 'ENOENT' });
  await assert.rejects(first.run(task.id), /--answer/);
  const resumed = new TaskEngine(localServices, store, new ScriptedProvider([
    messages => {
      const replies = messages.filter(message => message.role === 'tool');
      assert.equal(JSON.parse(replies[0].content!).data.answer, '项目经理');
      assert.equal(replies[1].tool_call_id, 'write_file');
      return turn();
    }
  ]));
  const completed = await resumed.run(task.id, { answer: '项目经理' });
  assert.equal(completed.status, 'waiting_acceptance');
  assert.equal(await readFile(path.join(store.workspace, 'after.md'), 'utf8'), '继续执行');
  assert.equal(completed.messages.filter(message => message.tool_call_id === 'ask_user').length, 1);
});

test('crash recovery reuses a tool receipt and does not duplicate an already-created child', async t => {
  const store = await fixture(t);
  const provider = new ScriptedProvider([() => turn()]);
  const engine = new TaskEngine(localServices, store, provider);
  const task = await engine.create({ kind: 'requirements', goal: '生成需求与任务' });
  const write = tool('write_file', { path: 'spec.md', content: '已生成需求', expected_sha256: null });
  const create = tool('create_task', { kind: 'tests', title: '验证需求', goal: '覆盖需求验收标准', acceptance_criteria: ['每条需求对应测试用例'] });
  await store.withLock(async () => {
    task.steps = 1;
    task.status = 'running';
    task.messages.push({ role: 'assistant', content: null, tool_calls: [write, create] });
    task.pendingCalls = [write, create];
    await store.save(task);
    const context = { task, store, services: localServices, workspace: new Workspace(store.workspace), signal: new AbortController().signal };
    const written = await executeTool(write.function.name, write.function.arguments, { ...context, callKey: '1:write_file' });
    await store.saveReceipt(task.id, '1:write_file', written);
    // Crash windows: first tool has a receipt, second effect exists without its receipt.
    await executeTool(create.function.name, create.function.arguments, { ...context, callKey: '1:create_task' });
  });
  const before = await stat(path.join(store.workspace, 'spec.md'));
  const recovered = await engine.run(task.id);
  assert.equal(recovered.status, 'waiting_acceptance');
  assert.equal((await stat(path.join(store.workspace, 'spec.md'))).mtimeMs, before.mtimeMs);
  assert.equal(recovered.childTaskIds.length, 1);
  assert.equal((await store.list()).length, 2);
  assert.ok((await store.events(task.id)).some(event => event.data.replayed === true));
});

test('step budget settles after pending tools, and an explicit larger budget resumes it', async t => {
  const store = await fixture(t);
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([() => turn(tool('list_files', {})), () => turn()]));
  const task = await engine.create({ kind: 'general', goal: '查看工作区', maxSteps: 1 });
  const limited = await engine.run(task.id);
  assert.equal(limited.status, 'budget_exceeded');
  assert.equal(limited.pendingCalls.length, 0);
  const result = await engine.run(task.id, { maxSteps: 2 });
  assert.equal(result.status, 'waiting_acceptance');
  await assert.rejects(engine.run(task.id), /等待验收/);
  await new TaskReviewer(localServices, store).review(task.id, 'accepted', '已确认产物');
  await assert.rejects(engine.run(task.id), /任务已完成/);
});

test('cancellation and provider failure preserve recoverable task state', async t => {
  const store = await fixture(t);
  const controller = new AbortController();
  const provider = new ScriptedProvider([
    (_messages, signal) => { signal.throwIfAborted(); return turn(); },
    () => { throw new Error('模型连接失败'); },
    () => turn()
  ]);
  const engine = new TaskEngine(localServices, store, provider);
  const task = await engine.create({ kind: 'general', goal: '可恢复任务' });
  const cancelled = await engine.run(task.id, { signal: controller.signal, onEvent: event => { if (event.type === 'model.started') controller.abort(); } });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await engine.run(task.id)).status, 'failed');
  assert.equal((await engine.run(task.id)).status, 'waiting_acceptance');
});

test('a task cannot silently switch model/provider on resume', async t => {
  const store = await fixture(t);
  const original = new TaskEngine(localServices, store, new DemoProvider('general'));
  const task = await original.create({ kind: 'general', goal: 'demo' });
  await assert.rejects(new TaskEngine(localServices, store, new ScriptedProvider([])).run(task.id), /模型配置/);
  assert.equal((await store.load(task.id)).status, 'pending');
});
