import { localServices } from '@taskweave/adapters';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseConfig } from '@taskweave/core';
import { loadConfig } from '@taskweave/adapters';
import { TaskEngine } from '@taskweave/core';
import { TaskReviewer } from '@taskweave/core';
import { main } from '@taskweave/cli';
import { fixture, ScriptedProvider, tool, turn } from '../helpers.ts';

test('a final answer waits for acceptance; accept uses fresh evidence without a model', async t => {
  const store = await fixture(t);
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([
    () => turn(tool('write_file', { path: 'spec.md', content: '需求已整理', expected_sha256: null })), () => turn()
  ]));
  const task = await engine.create({ kind: 'requirements', goal: '整理需求' });
  assert.equal((await engine.run(task.id)).status, 'waiting_acceptance');
  const result = await new TaskReviewer(localServices, store).review(task.id, 'accepted', '已核对业务范围');
  assert.equal(result.status, 'completed');
  assert.equal(result.approval?.decision, 'accepted');
  assert.equal(result.validationHistory?.length, 1);
  assert.equal(result.steps, 2);
});

test('failed independent validation feeds evidence into a repair and retains history', async t => {
  const store = await fixture(t);
  const provider = new ScriptedProvider([
    () => turn(),
    messages => {
      assert.match(messages.at(-1)!.content!, /独立验收未通过/);
      return turn(tool('write_file', { path: 'result.json', content: '{"scope":"team","acceptance":[]}', expected_sha256: null }));
    },
    () => turn()
  ]);
  const engine = new TaskEngine(localServices, store, provider);
  const task = await engine.create({ kind: 'requirements', goal: '生成结构化需求', validationPolicy: { requireApproval: false, checks: [], rules: [{ type: 'json_fields', path: 'result.json', fields: ['scope', 'acceptance'] }] } });
  const failed = await engine.run(task.id);
  assert.equal(failed.status, 'validation_failed');
  assert.ok(failed.validation!.items.some(item => !item.passed));
  const repaired = await engine.run(task.id);
  assert.equal(repaired.status, 'completed');
  assert.equal(repaired.validationHistory![0].status, 'failed');
  assert.equal(repaired.validation?.status, 'passed');
});

test('accept refuses externally modified artifacts and rejection is actionable feedback', async t => {
  const store = await fixture(t);
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([
    () => turn(tool('write_file', { path: 'doc.md', content: 'first', expected_sha256: null })), () => turn(),
    messages => { assert.match(messages.at(-1)!.content!, /补充权限/); return turn(); }
  ]));
  const task = await engine.create({ kind: 'document', goal: '生成说明' });
  await engine.run(task.id);
  await writeFile(path.join(store.workspace, 'doc.md'), 'outside edit');
  const stale = await new TaskReviewer(localServices, store).review(task.id, 'accepted', '已阅读');
  assert.equal(stale.status, 'validation_failed');
  assert.equal(stale.approval, undefined);
  await writeFile(path.join(store.workspace, 'doc.md'), 'first');
  await new TaskReviewer(localServices, store).validate(task.id);
  const rejected = await new TaskReviewer(localServices, store).review(task.id, 'rejected', '补充权限说明');
  assert.equal(rejected.status, 'validation_failed');
  assert.equal((await engine.run(task.id)).status, 'waiting_acceptance');
});

test('resume after generated-answer checkpoint performs validation without recalling the model', async t => {
  const store = await fixture(t);
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([]));
  const task = await engine.create({ kind: 'general', goal: '恢复验收' });
  await store.withLock(async () => {
    task.answer = '已经生成'; task.status = 'validating';
    await store.save(task);
  });
  assert.equal((await engine.run(task.id)).status, 'waiting_acceptance');
  assert.equal((await store.load(task.id)).steps, 0);
});

test('config changes are rejected before tools and child tasks inherit their kind policy', async t => {
  const store = await fixture(t);
  const config = parseConfig({ version: 1, validation: { tests: { rules: [{ type: 'exists', path: 'plan.md' }] } } });
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([
    () => turn(tool('create_task', { title: '测试', kind: 'tests', goal: '测试设计', acceptance_criteria: ['存在测试计划'] })), () => turn()
  ]), config);
  const task = await engine.create({ kind: 'requirements', goal: '分析' });
  await assert.rejects(new TaskEngine(localServices, store, new ScriptedProvider([])).run(task.id), /配置与创建任务时不同/);
  const result = await engine.run(task.id);
  const child = await store.load(result.childTaskIds[0]);
  assert.deepEqual(child.validationPolicy, config.validation.tests);
  assert.equal(child.executionConfigHash, result.executionConfigHash);
});

test('config rejects unsafe or misleading policies and ignores prototype properties as checks', async () => {
  for (const value of [
    { version: 1, validation: { code: { requireApproval: false } } },
    { version: 1, checks: { test: { command: 'node', cwd: '../outside' } } },
    { version: 1, validation: { tests: { checks: ['toString'] } } },
    { version: 1, checks: { test: { command: 'node', shell: true } } },
    { version: 1, validation: { document: { rules: [{ type: 'exists', path: '.env' }] } } }
  ]) assert.throws(() => parseConfig(value), /配置无效/);
});

test('CLI exposes independent validation and acceptance without provider credentials', async t => {
  const store = await fixture(t);
  const outputs: string[] = [];
  const io = { out: (line: string) => { outputs.push(line); }, err: (_line: string) => undefined };
  assert.equal(await main(['run', '--demo', '--kind', 'document', '--prompt', '演示', '--workspace', store.workspace, '--json'], io), 0);
  const task = JSON.parse(outputs.pop()!);
  assert.equal(task.status, 'waiting_acceptance');
  assert.equal(await main(['accept', task.id, '--workspace', store.workspace], io), 1);
  assert.equal(await main(['validate', task.id, '--workspace', store.workspace, '--json'], io), 0);
  assert.equal(await main(['accept', task.id, '--workspace', store.workspace, '--note', '核对完成', '--json'], io), 0);
  assert.equal(JSON.parse(outputs.pop()!).status, 'completed');
  const saved = JSON.parse(await readFile(path.join(store.directory, 'tasks', `${task.id}.json`), 'utf8'));
  assert.equal(saved.approval.note, '核对完成');
  assert.deepEqual(await loadConfig(store.workspace), parseConfig({ version: 1 }));
});

test('a crashed validation command remains unknown and cannot falsely complete the task', async t => {
  const store = await fixture(t);
  const config = parseConfig({ version: 1, checks: { verify: { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("should-not-run.txt","oops")'] } }, validation: { code: { checks: ['verify'], requireApproval: false } } });
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([]), config);
  const task = await engine.create({ kind: 'code', goal: '恢复验证' });
  await store.withLock(async () => {
    task.answer = '已交付'; task.status = 'validating';
    task.validation = { id: 'val_fixture', startedAt: new Date().toISOString(), status: 'running', items: [] };
    await store.save(task);
    await store.saveCheckRecord(task.id, 'validation:val_fixture:verify', { state: 'started' });
  });
  const result = await engine.run(task.id);
  assert.equal(result.status, 'validation_failed');
  assert.equal(result.validation!.items.find(item => item.check)?.check?.status, 'unknown');
  await assert.rejects(readFile(path.join(store.workspace, 'should-not-run.txt')), { code: 'ENOENT' });
});

test('v0.1 unfinished snapshots adopt acceptance while completed legacy tasks stay untouched', async t => {
  const store = await fixture(t);
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([() => turn()]));
  const task = await engine.create({ kind: 'document', goal: '旧任务' });
  await store.withLock(async () => {
    delete task.validationPolicy; delete task.executionConfigHash;
    await store.save(task);
  });
  const resumed = await engine.run(task.id);
  assert.equal(resumed.status, 'waiting_acceptance');
  assert.equal(resumed.validationPolicy?.requireApproval, true);
  assert.ok(resumed.executionConfigHash);
  const old = await engine.create({ kind: 'document', goal: '旧版已完成' });
  await store.withLock(async () => {
    old.status = 'completed'; delete old.validationPolicy; delete old.executionConfigHash;
    await store.save(old);
  });
  await assert.rejects(engine.run(old.id), /任务已完成/);
  assert.equal((await store.load(old.id)).validation, undefined);
});
