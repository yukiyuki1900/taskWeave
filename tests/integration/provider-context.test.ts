import { createTask } from '@taskweave/core';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatibleProvider, parseModelTurn } from '@taskweave/adapters';
import { buildContext } from '@taskweave/core';
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
