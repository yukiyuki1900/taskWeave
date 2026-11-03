import { createTask } from '@taskweave/core';
import { localServices } from '@taskweave/adapters';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Workspace } from '@taskweave/adapters';
import { sha256 } from '@taskweave/core';
import { executeTool } from '@taskweave/core';
import { fixture } from '../helpers.ts';

test('file updates reject stale hashes and accept a replay of the same intended content', async t => {
  const store = await fixture(t);
  const task = await store.withLock(() => createTask(store, { kind: 'code', goal: '修改代码' }, 'fixture:v1'));
  const context = { task, store, services: localServices, workspace: new Workspace(store.workspace), callKey: 'write', signal: new AbortController().signal };
  const args = (content: string, expected: string | null) => JSON.stringify({ path: 'code.ts', content, expected_sha256: expected });
  assert.equal((await executeTool('write_file', args('original', null), context)).ok, true);
  await writeFile(path.join(store.workspace, 'code.ts'), 'user edit');
  const conflict = await executeTool('write_file', args('agent edit', sha256('original')), context);
  assert.equal(conflict.error?.code, 'CONTENT_CONFLICT');
  assert.equal(await readFile(path.join(store.workspace, 'code.ts'), 'utf8'), 'user edit');
  assert.equal((await executeTool('write_file', args('agent edit', sha256('user edit')), context)).ok, true);
  const replay = await executeTool('write_file', args('agent edit', sha256('user edit')), context);
  assert.equal((replay.data as { changed: boolean }).changed, false);
});

test('tools deny traversal, hidden state, credential extensions and symlinks', async t => {
  const store = await fixture(t);
  const workspace = new Workspace(store.workspace);
  for (const target of ['../escape', '/absolute', '.taskweave/tasks', '.env', 'cert/private.pem', 'a/../../escape', 'a\\b']) {
    await assert.rejects(workspace.resolve(target), /禁止|相对路径/);
  }
  await mkdir(path.join(store.workspace, 'normal'));
  await writeFile(path.join(store.workspace, 'normal', 'file.md'), 'data');
  await symlink(path.join(store.workspace, 'normal'), path.join(store.workspace, 'alias'));
  await assert.rejects(workspace.read('alias/file.md'), /符号链接/);
  assert.deepEqual((await workspace.walk()).files, ['normal/file.md']);
});

test('text tools report search limits and reject binary files and invalid arguments', async t => {
  const store = await fixture(t);
  const task = await store.withLock(() => createTask(store, { kind: 'document', goal: '搜索资料' }, 'fixture:v1'));
  const ctx = { task, store, services: localServices, workspace: new Workspace(store.workspace), callKey: 'search', signal: new AbortController().signal };
  await writeFile(path.join(store.workspace, 'notes.md'), 'Alpha\nalpha again\nBeta\n');
  await writeFile(path.join(store.workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
  const result = await executeTool('search_files', JSON.stringify({ query: 'ALPHA', limit: 1 }), ctx);
  const data = result.data as { matches: Array<{ path: string; line: number }>; truncated: boolean };
  assert.equal(data.matches[0].path, 'notes.md');
  assert.equal(data.matches[0].line, 1);
  assert.equal(data.truncated, true);
  assert.equal((await executeTool('read_file', '{"path":"binary.bin"}', ctx)).error?.code, 'BINARY_FILE');
  assert.equal((await executeTool('read_file', '{"path":"notes.md","secret":true}', ctx)).error?.code, 'INVALID_ARGUMENTS');
  assert.equal((await executeTool('write_file', '{"path":"x","content":"x"}', ctx)).error?.code, 'INVALID_ARGUMENTS');
  assert.equal((await executeTool('read_file', 'not JSON', ctx)).error?.code, 'INVALID_ARGUMENTS');
});

test('workspace lock rejects another executor and cannot unlock a live owner', async t => {
  const store = await fixture(t);
  await store.withLock(async () => {
    await assert.rejects(store.withLock(async () => 'second'), /工作区已有执行器/);
    await assert.rejects(store.unlock(), /仍然存活/);
  });
  await store.withLock(async () => undefined);
});

test('a torn final event append is repaired before writing the next sequence', async t => {
  const store = await fixture(t);
  await store.withLock(async () => {
    const task = await createTask(store, { kind: 'general', goal: '事件恢复' }, 'fixture:v1');
    await appendFile(path.join(store.directory, 'events', `${task.id}.jsonl`), '{"seq":999');
    assert.equal((await store.events(task.id)).length, 1);
    await store.emit(task, 'recovered', {});
    assert.deepEqual((await store.events(task.id)).map(event => event.seq), [1, 2]);
    assert.deepEqual((await store.events(task.id, 1)).map(event => event.type), ['recovered']);
  });
});
