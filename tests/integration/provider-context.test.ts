import { createTask } from '@taskweave/core';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CompatibleProvider, loadWorkflow, localServices, parseModelTurn } from '@taskweave/adapters';
import { buildContext, currentAttempt, parseConfig, TaskEngine, WorkflowEngine } from '@taskweave/core';
import type { Message } from '@taskweave/core/types';
import { fixture, tool } from '../helpers.ts';

test('provider parses tool calls, reasoning and usage, rejecting truncated or duplicate calls', () => {
  const call = tool('list_files', {});
  const value = { choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'reason', tool_calls: [call] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } };
  assert.deepEqual(parseModelTurn(value), { content: null, toolCalls: [call], reasoningContent: 'reason', usage: { input: 12, output: 3 } });
  assert.throws(() => parseModelTurn({ choices: [{ finish_reason: 'length', message: {} }] }), /长度上限/);
  assert.throws(() => parseModelTurn({ choices: [{ message: { tool_calls: [call, call] } }] }), /重复/);
  assert.throws(() => parseModelTurn({ choices: [{ message: { content: '' } }] }), /空回答/);
});

test('HTTP adapter sends the expected contract, retries a transient failure and keeps credentials out of errors', async () => {
  let requests = 0;
  const provider = new CompatibleProvider({ baseUrl: 'https://model.example/v1', apiKey: 'private-key', model: 'example-model', fetch: async (url, init) => {
    requests++;
    assert.equal(url, 'https://model.example/v1/chat/completions');
    assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer private-key');
    assert.equal(JSON.parse(init!.body as string).stream, false);
    return requests === 1 ? new Response('temporary', { status: 503 }) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
  } });
  assert.equal((await provider.complete([{ role: 'user', content: 'task' }], [], new AbortController().signal)).content, 'done');
  assert.equal(requests, 2);
  assert.ok(!provider.id.includes('private-key'));
  const rejected = new CompatibleProvider({ baseUrl: 'https://model.example/v1', apiKey: 'private-key', model: 'x', fetch: async () => new Response('private-key echoed by server', { status: 401 }) });
  await assert.rejects(rejected.complete([], [], new AbortController().signal), error => error instanceof Error && error.message === '模型服务返回 HTTP 401');
});

test('HTTP adapter rejects credential-bearing URLs and respects pre-cancellation', async () => {
  assert.throws(() => new CompatibleProvider({ baseUrl: 'https://user:password@model.example', apiKey: 'x', model: 'x' }), /不能包含凭据/);
  let fetched = false;
  const provider = new CompatibleProvider({ baseUrl: 'https://model.example', apiKey: 'x', model: 'x', fetch: async () => { fetched = true; return Response.json({}); } });
  await assert.rejects(provider.complete([], [], AbortSignal.abort()));
  assert.equal(fetched, false);
});

test('tool history preserves absent, empty, null and nonempty reasoning through a checkpoint and the next HTTP request', async t => {
  for (const reasoning of [undefined, '', null, 'reason']) {
    await t.test(`reasoning=${JSON.stringify(reasoning)}`, async t => {
      const store = await fixture(t);
      let requests = 0;
      const provider = new CompatibleProvider({ baseUrl: 'https://model.example/v1', apiKey: 'fixture-key', model: 'fixture', fetch: async (_url, init) => {
        requests++;
        if (requests === 1) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
          content: null, tool_calls: [tool('list_files', {})],
          ...(reasoning !== undefined ? { reasoning_content: reasoning } : {})
        } }] });
        const { messages } = JSON.parse(init!.body as string);
        const assistant = messages.find((message: { role: string }) => message.role === 'assistant');
        assert.equal(Object.hasOwn(assistant, 'reasoning_content'), reasoning !== undefined);
        assert.equal(assistant.reasoning_content, reasoning);
        assert.deepEqual(assistant.tool_calls, [tool('list_files', {})]);
        assert.equal(messages.at(-1).tool_call_id, 'list_files');
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
      } });
      const engine = new TaskEngine(localServices, store, provider);
      const created = await engine.create({ kind: 'general', goal: '查看工作区', maxSteps: 1 });
      assert.equal((await engine.run(created.id)).status, 'budget_exceeded');
      const saved = (await store.load(created.id)).messages.find(message => message.role === 'assistant')!;
      assert.equal(Object.hasOwn(saved, 'reasoning_content'), reasoning !== undefined);
      assert.equal(saved.reasoning_content, reasoning);
      assert.deepEqual(saved.tool_calls, [tool('list_files', {})]);
      const resumed = await new TaskEngine(localServices, store, provider).run(created.id, { maxSteps: 2 });
      assert.equal(resumed.status, 'waiting_acceptance');
      assert.equal(requests, 2);
    });
  }
});

test('workflow sends complete tool batches across live HTTP turns, including failed tool observations', async t => {
  const store = await fixture(t);
  const requirements = { scope: '字符串标题规范化', stories: ['规范化标题'], rules: ['仅处理字符串'], acceptance: ['空白字符串返回空字符串'] };
  const batches = [
    [tool('list_files', {}, 'list'), tool('ask_user', {}, 'invalid-question')],
    [tool('write_file', { path: 'artifacts/requirements.json', content: JSON.stringify(requirements), expected_sha256: null }, 'write')]
  ];
  let requests = 0;
  const provider = new CompatibleProvider({ baseUrl: 'https://model.example/v1', apiKey: 'fixture-key', model: 'fixture', fetch: async (_url, init) => {
    const { messages } = JSON.parse(init!.body as string) as { messages: Message[] };
    const round = requests++;
    assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => message.tool_calls), batches.slice(0, round));
    assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), batches.slice(0, round).flat().map(call => call.id));
    if (round > 0) {
      const observation = messages.find(message => message.tool_call_id === 'invalid-question')!;
      assert.equal(JSON.parse(observation.content!).error.code, 'INVALID_ARGUMENTS');
    }
    return Response.json({ choices: [{ finish_reason: round < batches.length ? 'tool_calls' : 'stop', message: {
      content: round < batches.length ? null : '需求已交付，等待人工确认', reasoning_content: '',
      ...(round < batches.length ? { tool_calls: batches[round] } : {})
    } }] });
  } });
  const config = parseConfig(JSON.parse(await readFile('examples/workflows/config.json', 'utf8')));
  const engine = new WorkflowEngine(localServices, store, () => provider, config);
  const created = await engine.create(await loadWorkflow('examples/workflows/delivery.json'));
  const result = await engine.run(created.id);
  const attempt = currentAttempt(result.nodes[0])!;
  assert.equal(result.status, 'waiting_acceptance', attempt.error);
  assert.equal(result.nodes[0].status, 'waiting_acceptance');
  assert.ok(result.nodes.slice(1).every(node => node.status === 'blocked'));
  const saved = await store.load(attempt.taskId);
  assert.deepEqual(saved.messages.filter(message => message.tool_calls).map(message => message.tool_calls), batches);
  assert.deepEqual(saved.pendingCalls, []);
  assert.equal(saved.validation?.status, 'passed');
  assert.equal(requests, 3);
});

test('pausing inside a tool batch and resuming preserves all original call IDs', async t => {
  const store = await fixture(t);
  const batch = [tool('list_files', {}, 'before'), tool('ask_user', { question: '目标用户是谁？' }, 'question'), tool('list_files', {}, 'after')];
  let requests = 0;
  const provider = new CompatibleProvider({ baseUrl: 'https://model.example/v1', apiKey: 'fixture-key', model: 'fixture', fetch: async (_url, init) => {
    if (++requests === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: batch } }] });
    const { messages } = JSON.parse(init!.body as string) as { messages: Message[] };
    assert.deepEqual(messages.find(message => message.role === 'assistant')!.tool_calls, batch);
    assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), batch.map(call => call.id));
    assert.equal(JSON.parse(messages.find(message => message.tool_call_id === 'question')!.content!).data.answer, '项目经理');
    return Response.json({ choices: [{ message: { content: 'done' } }] });
  } });
  const engine = new TaskEngine(localServices, store, provider);
  const created = await engine.create({ kind: 'general', goal: '查看工作区并确认目标用户' });
  const waiting = await engine.run(created.id);
  assert.equal(waiting.status, 'waiting_input');
  const saved = await store.load(created.id);
  assert.deepEqual(saved.messages.find(message => message.role === 'assistant')!.tool_calls, batch);
  assert.deepEqual(saved.pendingCalls.map(call => call.id), ['question', 'after']);
  const resumed = await new TaskEngine(localServices, store, provider).run(created.id, { answer: '项目经理' });
  assert.equal(resumed.status, 'waiting_acceptance', resumed.error);
  assert.equal(requests, 2);
});

test('HTTP 400 hints classify known fields without leaking provider text or retrying', async () => {
  const cases = [
    ['Missing reasoning_content: private-key private-prompt', /reasoning_content/],
    ['Invalid tool_call_id: private-key private-prompt', /工具调用历史/],
    ['Invalid max_tokens: private-key private-prompt', /输出长度参数/],
    ['Invalid thinking: private-key private-prompt', /思考模式参数/],
    ['Unknown: private-key private-prompt', /^模型服务返回 HTTP 400$/]
  ] as const;
  for (const [message, expected] of cases) {
    let requests = 0;
    const provider = new CompatibleProvider({ baseUrl: 'https://model.example', apiKey: 'private-key', model: 'fixture', fetch: async () => {
      requests++;
      return Response.json({ error: { message } }, { status: 400 });
    } });
    await assert.rejects(provider.complete([], [], new AbortController().signal), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-key|private-prompt/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('HTTP 400 diagnostics discard malformed and oversized bodies and cancel a stalled read', async () => {
  for (const body of ['<html>private-key</html>', JSON.stringify({ error: { message: `reasoning_content ${'x'.repeat(16 * 1024)}` } })]) {
    const provider = new CompatibleProvider({ baseUrl: 'https://model.example', apiKey: 'private-key', model: 'fixture', fetch: async () => new Response(body, { status: 400 }) });
    await assert.rejects(provider.complete([], [], new AbortController().signal), error => error instanceof Error && error.message === '模型服务返回 HTTP 400');
  }
  const controller = new AbortController();
  let cancelled = false;
  const provider = new CompatibleProvider({ baseUrl: 'https://model.example', apiKey: 'private-key', model: 'fixture', fetch: async () => new Response(new ReadableStream({
    pull: () => { setImmediate(() => controller.abort(new Error('fixture cancelled'))); },
    cancel: () => { cancelled = true; }
  }), { status: 400 }) });
  await assert.rejects(provider.complete([], [], controller.signal), /fixture cancelled/);
  assert.equal(cancelled, true);
});

test('context compaction preserves the goal, artifact manifest and complete recent tool rounds', async t => {
  const store = await fixture(t);
  const task = await store.withLock(() => createTask(store, { kind: 'general', goal: '保留原始目标' }, 'fixture:v1'));
  task.artifacts = [{ path: 'artifacts/spec.md', sha256: 'a'.repeat(64), bytes: 42 }];
  for (let index = 0; index < 4; index++) {
    const call = tool('read_file', { path: `source-${index}.md` }, `read-${index}`);
    task.messages.push({ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'x'.repeat(3000) });
  }
  const compact = buildContext(task, 6_000);
  assert.ok(compact.archivedRounds > 0);
  assert.equal(compact.messages[1].content, '保留原始目标');
  assert.match(compact.messages[2].content!, /artifacts\/spec.md/);
  const recentAssistant = compact.messages.find(message => message.role === 'assistant')!;
  assert.equal(compact.messages.at(-1)!.tool_call_id, recentAssistant.tool_calls![0].id);
  assert.equal(task.messages.length, 10, 'original checkpoint messages remain intact');
});
