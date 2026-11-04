import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FileStateReader, localServices } from '@taskweave/adapters';
import { TaskEngine, WorkflowEngine, currentAttempt, readWorkflowReport, sha256 } from '@taskweave/core';
import { createLocalReadApi } from '@taskweave/server';
import { fixture, ScriptedProvider, tool, turn } from '../helpers.ts';

const origin = 'http://127.0.0.1:4310';
const clock = () => '2027-01-01T00:00:00.000Z';
type Handler = (request: Request) => Promise<Response>;
async function get(api: Handler, route: string) {
  const response = await api(new Request(origin + '/api/v1/' + route));
  const body = await response.json(); return { response, body };
}
async function tree(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const info = await lstat(path.join(root, name));
    result[name] = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : { sha256: sha256(await readFile(path.join(root, name))), mtimeMs: info.mtimeMs, mode: info.mode };
  }
  return result;
}
async function writer(store: Awaited<ReturnType<typeof fixture>>, file = 'result.md') {
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([
    () => turn(tool('write_file', { path: file, content: 'recorded-content', expected_sha256: null })), () => turn()
  ]));
  return engine.run((await engine.create({ kind: 'document', goal: '生成说明' })).id);
}
async function workflow(store: Awaited<ReturnType<typeof fixture>>) {
  const engine = new WorkflowEngine(localServices, store, node => new ScriptedProvider([
    () => turn(tool('write_file', { path: `${node.id}.md`, content: node.id, expected_sha256: null })), () => turn()
  ]));
  let run = await engine.run((await engine.create({ version: 1, name: 'delivery', nodes: [
    { id: 'requirements', kind: 'requirements', goal: '需求' }, { id: 'docs', kind: 'document', goal: '文档', dependsOn: ['requirements'] }
  ] })).id);
  run = await engine.review(run.id, 'requirements', currentAttempt(run.nodes[0])!.id, 'accepted', '已核对');
  run = await engine.review(run.id, 'docs', currentAttempt(run.nodes[1])!.id, 'accepted', '已核对');
  return { engine, run };
}

test('all observation routes work while CLI holds the workspace lock, with no file changes or model configuration', async t => {
  const store = await fixture(t); const task = await writer(store); const { run } = await workflow(store);
  await writeFile(path.join(store.directory, 'config.json'), '{ invalid config and SECRET_CONFIG');
  await writeFile(path.join(store.workspace, '.env'), 'TASKWEAVE_API_KEY=SECRET_ENV');
  const reader = await FileStateReader.open(store.workspace);
  for (const method of ['save', 'saveWorkflow', 'withLock', 'emit', 'saveReceipt', 'checkRecord']) assert.equal(method in reader, false);
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  await store.withLock(async () => {
    const before = await tree(store.workspace);
    const detail = await get(api, `tasks/${task.id}`); assert.equal(detail.response.status, 200);
    const artifactId = detail.body.data.artifacts[0].id;
    for (const route of ['workspace', 'tasks', 'tasks?scope=all', 'workflows', `tasks/${task.id}`, `workflows/${run.id}`, `workflows/${run.id}/report`, `tasks/${task.id}/artifacts/${artifactId}`, `events?scope=task&id=${task.id}`, `events?scope=workflow&id=${run.id}`]) {
      const { response, body } = await get(api, route);
      assert.equal(response.status, 200, route); assert.equal(body.apiVersion, 1); assert.equal(body.observedAt, clock());
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(JSON.stringify(body).includes('SECRET_'), false);
    }
    assert.deepEqual(await tree(store.workspace), before);
  });
  assert.equal((await get(api, 'tasks')).body.data.items.length, 1);
  assert.equal((await get(api, 'tasks?scope=all')).body.data.items.length, 3);
  assert.deepEqual((await get(api, `workflows/${run.id}`)).body.data.nodes.map((node: { status: string }) => node.status), ['succeeded', 'succeeded']);
});

test('HTTP report preserves CLI statistics including invalidated attempt cost and omits provider endpoints', async t => {
  const store = await fixture(t); const { engine, run } = await workflow(store);
  const old = currentAttempt(run.nodes[0])!;
  await engine.rework(run.id, 'requirements', old.id, '重新核对');
  const rerun = await engine.run(run.id); assert.equal(rerun.status, 'waiting_acceptance');
  const task = await store.load(currentAttempt(rerun.nodes[0])!.taskId);
  task.provider = 'compatible:https://user:SECRET_PROVIDER@example.invalid/v1?key=PRIVATE:model'; await store.save(task);
  currentAttempt(rerun.nodes[0])!.provider = task.provider; await store.withLock(() => store.saveWorkflow(rerun));
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  const { body, response } = await get(api, `workflows/${run.id}/report`); assert.equal(response.status, 200);
  const expected = await readWorkflowReport(store, run.id, clock());
  assert.deepEqual(body.data.summary, expected.summary);
  assert.equal(body.data.summary.invalidatedAttempts, 2);
  assert.ok(body.data.summary.total.inputTokens > body.data.summary.current.inputTokens);
  assert.ok(body.revision.tasks[task.id] > 0);
  assert.equal(JSON.stringify(body).includes('SECRET_PROVIDER'), false);
  assert.equal(body.data.nodes[0].attempts.at(-1).providerMode, 'model');
  const oldView = await get(api, `tasks/${old.taskId}`); assert.equal(oldView.body.data.currentAttempt, false);
});

test('task projection exposes results and evidence while excluding checkpoint messages, queues, config and command output', async t => {
  const store = await fixture(t); const task = await writer(store);
  task.messages[0].content = 'SECRET_SYSTEM_PROMPT';
  task.messages.push({ role: 'assistant', content: 'SECRET_RAW_MESSAGE', reasoning_content: 'SECRET_REASONING' });
  task.pendingCalls = [tool('write_file', { content: 'SECRET_PENDING' })];
  task.error = `failure at ${store.workspace}/result.md`;
  task.answer = 'x'.repeat(20_001);
  task.validation!.items[0].check = { name: 'verify', status: 'passed', exitCode: 0, stdout: 'SECRET_STDOUT', stderr: 'SECRET_STDERR', durationMs: 1 };
  (task as unknown as Record<string, unknown>).internalSecret = 'SECRET_EXTRA';
  await store.save(task);
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  const { body } = await get(api, `tasks/${task.id}`);
  const encoded = JSON.stringify(body);
  assert.equal(encoded.includes('SECRET_'), false); assert.equal(encoded.includes(store.workspace), false);
  assert.match(body.data.error, /<workspace>/);
  assert.equal(body.data.answer.length, 20_000); assert.equal(body.data.answerTruncated, true);
  assert.equal(body.data.summary.kind, 'extractive'); assert.equal(body.data.summary.evidenceCurrent, false);
  assert.equal(body.data.validation.items[0].check.status, 'passed');
  assert.equal('stdout' in body.data.validation.items[0].check, false);
});

test('pagination is stable across inserts, deterministic on ties and bound to status/scope filters', async t => {
  const store = await fixture(t); const engine = new TaskEngine(localServices, store, new ScriptedProvider([]));
  for (let index = 0; index < 4; index++) { const task = await engine.create({ kind: 'general', goal: `${index}` }); task.createdAt = '2026-01-01T00:00:00.000Z'; await store.save(task); }
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  const first = (await get(api, 'tasks?limit=2')).body.data;
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  await engine.create({ kind: 'general', goal: 'newer' });
  const second = (await get(api, `tasks?limit=2&cursor=${first.nextCursor}`)).body.data;
  assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(task => task.id)).size, 4);
  for (const route of [`tasks?status=failed&cursor=${first.nextCursor}`, `tasks?scope=all&cursor=${first.nextCursor}`, 'tasks?cursor=not-json', 'tasks?limit=0', 'tasks?limit=101', 'tasks?limit=2&limit=3', 'tasks?status=made-up', 'tasks?scope=bad', 'tasks?workspace=other', 'workflows?scope=all']) assert.equal((await get(api, route)).response.status, 400, route);
});

test('artifact IDs select only registered files, verify hashes and never return changed content as a historical version', async t => {
  const store = await fixture(t); const task = await writer(store); const api = await createLocalReadApi(store.workspace, { origin, clock });
  const artifactId = (await get(api, `tasks/${task.id}`)).body.data.artifacts[0].id;
  const route = `tasks/${task.id}/artifacts/${artifactId}`;
  const original = await get(api, route); assert.equal(original.body.data.content, 'recorded-content'); assert.equal(original.body.data.format, 'markdown');
  await writeFile(path.join(store.workspace, 'result.md'), 'CHANGED_SECRET_CONTENT');
  const changed = await get(api, route); assert.equal(changed.response.status, 409); assert.equal(changed.body.error.code, 'ARTIFACT_CHANGED');
  assert.equal(changed.body.error.details.recordedSha256, sha256('recorded-content')); assert.equal('content' in changed.body.error.details, false);
  assert.equal(JSON.stringify(changed.body).includes('CHANGED_SECRET_CONTENT'), false);
  assert.equal((await get(api, `tasks/${task.id}/artifacts/art_${'0'.repeat(24)}`)).response.status, 404);
  assert.equal((await get(api, `tasks/${task.id}/artifacts/..%2F.env`)).response.status, 400);
  await writeFile(path.join(store.workspace, 'result.md'), Buffer.alloc(512 * 1024 + 1, 65)); assert.equal((await get(api, route)).response.status, 413);
  await writeFile(path.join(store.workspace, 'result.md'), Buffer.from([65, 0, 66])); assert.equal((await get(api, route)).response.status, 415);
  await writeFile(path.join(store.workspace, 'result.md'), Buffer.from([0xff])); assert.equal((await get(api, route)).response.status, 415);
  await rm(path.join(store.workspace, 'result.md')); assert.equal((await get(api, route)).body.error.code, 'ARTIFACT_MISSING');
});

test('HTML artifacts remain JSON text and missing files do not disclose filesystem error paths', async t => {
  const store = await fixture(t); const task = await writer(store, 'page.html');
  const file = path.join(store.workspace, 'page.html'); const html = '<script>alert("x")</script>';
  await writeFile(file, html); task.artifacts[0].sha256 = sha256(html); await store.save(task);
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  const artifactId = (await get(api, `tasks/${task.id}`)).body.data.artifacts[0].id;
  const { response, body } = await get(api, `tasks/${task.id}/artifacts/${artifactId}`);
  assert.match(response.headers.get('content-type')!, /application\/json/); assert.equal(body.data.format, 'text'); assert.equal(body.data.content, html);
  const missing = await get(api, `tasks/tw_${'0'.repeat(24)}`); assert.equal(missing.response.status, 404); assert.equal(JSON.stringify(missing.body).includes(store.workspace), false);
});

test('artifact, snapshot and log-directory symbolic links are denied without following their targets', async t => {
  const store = await fixture(t); const task = await writer(store);
  await writeFile(path.join(store.workspace, 'secret.txt'), 'SECRET_LINK_TARGET');
  await rm(path.join(store.workspace, 'result.md')); await symlink('secret.txt', path.join(store.workspace, 'result.md'));
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  const artifactId = (await get(api, `tasks/${task.id}`)).body.data.artifacts[0].id;
  assert.equal((await get(api, `tasks/${task.id}/artifacts/${artifactId}`)).response.status, 403);
  const snapshot = path.join(store.directory, 'tasks', `${task.id}.json`);
  const saved = await readFile(snapshot); await writeFile(path.join(store.workspace, 'snapshot-copy.json'), saved);
  await rm(snapshot); await symlink('../../snapshot-copy.json', snapshot);
  assert.equal((await get(api, `tasks/${task.id}`)).response.status, 403);
  await rm(snapshot); await writeFile(snapshot, saved);
  await rm(path.join(store.directory, 'events'), { recursive: true }); await mkdir(path.join(store.workspace, 'fake-events'));
  await symlink('../fake-events', path.join(store.directory, 'events'));
  assert.equal((await get(api, `events?scope=task&id=${task.id}`)).response.status, 403);
});

test('event cursors are per owner, snapshot-bounded and do not repair torn tails or leak raw data', async t => {
  const store = await fixture(t); const engine = new TaskEngine(localServices, store, new ScriptedProvider([]));
  const task = await engine.create({ kind: 'general', goal: '目标' });
  await store.emit(task, 'tool.completed', { name: 'read_file', callId: 'call_1', replayed: false, stdout: 'SECRET_EVENT', answer: 'SECRET_ANSWER', step: 1 });
  const log = path.join(store.directory, 'events', `${task.id}.jsonl`);
  const future = { taskId: task.id, seq: task.seq + 1, time: new Date().toISOString(), type: 'task.completed', data: {} };
  await appendFile(log, JSON.stringify(future) + '\n' + '{"unfinished":');
  const before = await readFile(log, 'utf8'); const api = await createLocalReadApi(store.workspace, { origin, clock });
  const first = (await get(api, `events?scope=task&id=${task.id}&limit=1`)).body.data;
  assert.equal(first.items.length, 1); assert.equal(first.hasMore, true); assert.equal(first.nextAfter, 1);
  const second = (await get(api, `events?scope=task&id=${task.id}&after=1`)).body.data;
  assert.equal(second.items.length, 1); assert.equal(second.nextAfter, task.seq); assert.equal(second.complete, true);
  assert.equal(second.items[0].data.name, 'read_file'); assert.equal(second.items[0].data.replayed, false);
  assert.equal(JSON.stringify(second).includes('SECRET_'), false);
  assert.equal(await readFile(log, 'utf8'), before);
  assert.equal((await get(api, `events?scope=task&id=${task.id}&after=99`)).body.error.code, 'CURSOR_AHEAD');
  assert.equal((await get(api, `events?scope=workflow&id=${task.id}`)).response.status, 400);
  task.seq += 2; await store.save(task);
  const partial = await get(api, `events?scope=task&id=${task.id}`); assert.equal(partial.body.data.complete, false); assert.ok(partial.body.warnings.length);
});

test('old workspaces lacking workflow logs, validation, summary or Skill stay readable without migration', async t => {
  const store = await fixture(t); const task = await new TaskEngine(localServices, store, new ScriptedProvider([])).create({ kind: 'general', goal: '旧任务' });
  delete task.summary; delete task.skills; delete task.validation; await store.save(task);
  for (const directory of ['workflows', 'events', 'check-runs', 'receipts']) await rm(path.join(store.directory, directory), { recursive: true });
  const api = await createLocalReadApi(store.workspace, { origin, clock }); const before = await tree(store.workspace);
  assert.deepEqual((await get(api, 'workflows')).body.data.items, []);
  const detail = (await get(api, `tasks/${task.id}`)).body.data; assert.equal(detail.summary, null); assert.equal(detail.validation, null); assert.deepEqual(detail.skills, []);
  const events = (await get(api, `events?scope=task&id=${task.id}`)).body; assert.equal(events.data.complete, false); assert.ok(events.warnings.length);
  assert.deepEqual(await tree(store.workspace), before);
});

test('startup never initializes missing state and damaged snapshots return sanitized errors', async t => {
  const store = await fixture(t); const missing = path.join(store.workspace, 'does-not-exist');
  await assert.rejects(createLocalReadApi(missing)); await assert.rejects(lstat(missing), { code: 'ENOENT' });
  const task = await new TaskEngine(localServices, store, new ScriptedProvider([])).create({ kind: 'general', goal: '目标' });
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  await writeFile(path.join(store.directory, 'tasks', `${task.id}.json`), '{ SECRET_INVALID');
  const damaged = await get(api, `tasks/${task.id}`); assert.equal(damaged.response.status, 503); assert.equal(damaged.body.error.code, 'DATA_UNAVAILABLE');
  assert.equal(JSON.stringify(damaged.body).includes('SECRET_INVALID'), false);
});

test('read-only methods, origin rules and strict arguments reject requests before reading data', async t => {
  const store = await fixture(t); const api = await createLocalReadApi(store.workspace, { origin, clock });
  const before = await tree(store.workspace);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await api(new Request(origin + '/api/v1/workspace', { method }));
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
  }
  for (const request of [new Request('http://evil.invalid/api/v1/workspace'), new Request(origin + '/api/v1/workspace', { headers: { origin: 'http://evil.invalid' } }), new Request(origin + '/api/v1/workspace', { headers: { 'sec-fetch-site': 'cross-site' } })]) assert.equal((await api(request)).status, 403);
  for (const route of ['tasks/not-an-id', 'workflows/not-an-id', 'events?scope=bad', 'events?scope=task&id=invalid', 'events?scope=task&id=invalid&after=-1', 'workspace?path=.env']) assert.equal((await get(api, route)).response.status, 400);
  assert.equal((await get(api, 'no-such-route')).response.status, 404);
  assert.deepEqual(await tree(store.workspace), before);
});

test('node context views preserve handoff identities and Skill bindings without publishing internal fields', async t => {
  const store = await fixture(t); const { run } = await workflow(store);
  const task = await store.load(currentAttempt(run.nodes[1])!.taskId);
  task.skills = [{ id: 'doc-style', description: '文档规范', path: 'skills/doc-style/SKILL.md', version: '1.0.0', sha256: 'a'.repeat(64) }];
  (task.skills[0] as unknown as Record<string, unknown>).secret = 'SECRET_SKILL';
  (task.handoff!.sources[0] as unknown as Record<string, unknown>).secret = 'SECRET_HANDOFF';
  await store.save(task);
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  const { body } = await get(api, `tasks/${task.id}`);
  assert.equal(body.data.currentAttempt, true); assert.equal(body.data.skills[0].version, '1.0.0');
  const source = body.data.handoff.sources[0];
  assert.equal(source.attemptId, run.nodes[0].currentAttemptId);
  assert.equal(source.taskId, currentAttempt(run.nodes[0])!.taskId);
  assert.equal(source.summary.kind, 'extractive'); assert.ok(source.summary.outcome.evidence[0].sha256);
  assert.equal('sourceHash' in source.summary, false);
  assert.equal(JSON.stringify(body).includes('SECRET_'), false);
});

test('missing task records remain visible as incomplete workflow/report data instead of zero-cost success', async t => {
  const store = await fixture(t); const { run } = await workflow(store);
  await rm(path.join(store.directory, 'tasks', `${currentAttempt(run.nodes[0])!.taskId}.json`));
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  const detail = await get(api, `workflows/${run.id}`); assert.equal(detail.response.status, 200); assert.ok(detail.body.warnings.length);
  const report = await get(api, `workflows/${run.id}/report`); assert.equal(report.response.status, 200);
  assert.equal(report.body.data.summary.dataComplete, false); assert.ok(report.body.warnings.length);
  assert.equal(report.body.data.nodes[0].attempts[0].dataComplete, false);
});

test('foreign event ownership cannot produce a complete HTTP report or timeline', async t => {
  const store = await fixture(t); const { run } = await workflow(store);
  const taskId = currentAttempt(run.nodes[0])!.taskId;
  const log = path.join(store.directory, 'events', `${taskId}.jsonl`);
  const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => ({ ...JSON.parse(line), taskId: `tw_${'0'.repeat(24)}` }));
  await writeFile(log, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const api = await createLocalReadApi(store.workspace, { origin, clock });
  const report = await get(api, `workflows/${run.id}/report`);
  assert.equal(report.body.data.summary.dataComplete, false); assert.ok(report.body.warnings.length);
  const events = await get(api, `events?scope=task&id=${taskId}`);
  assert.equal(events.body.data.complete, false); assert.deepEqual(events.body.data.items, []);
});
