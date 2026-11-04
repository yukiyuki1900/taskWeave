import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { main } from '@taskweave/cli';
import { currentAttempt, WorkflowEngine } from '@taskweave/core';
import { localServices } from '@taskweave/adapters';
import { fixture, ScriptedProvider } from '../helpers.ts';
import type { WorkflowRun } from '@taskweave/contracts';
import type { WorkflowReport } from '@taskweave/contracts';

test('workflow CLI creates, pauses, accepts each gate and continues four demo nodes', async t => {
  const store = await fixture(t);
  const output: string[] = [];
  const errors: string[] = [];
  const io = { out: (line: string) => { output.push(line); }, err: (line: string) => { errors.push(line); } };
  const invoke = (args: string[]) => main(['workflow', ...args, '--workspace', store.workspace, '--json'], io);
  assert.equal(await invoke(['run', '--file', 'examples/workflows/demo.json', '--demo']), 0);
  let run = JSON.parse(output.pop()!) as WorkflowRun;
  assert.equal(run.status, 'waiting_acceptance');
  assert.equal((await store.list()).length, 1);
  const first = currentAttempt(run.nodes[0])!.id;
  for (const id of ['requirements', 'implementation', 'tests', 'documentation']) {
    const node = run.nodes.find(node => node.id === id)!;
    assert.equal(node.status, 'waiting_acceptance');
    assert.equal(await invoke(['accept', run.id, '--node', id, '--attempt', node.currentAttemptId!, '--note', '已核对模板与节点产物', '--demo']), 0);
    run = JSON.parse(output.pop()!);
  }
  assert.equal(run.status, 'completed');
  assert.equal((await store.list()).length, 4);
  assert.ok((await store.list()).every(task => task.childTaskIds.length === 0));
  assert.equal(await invoke(['report', run.id]), 0);
  const report = JSON.parse(output.pop()!) as WorkflowReport;
  assert.equal(report.summary.succeededNodes, 4);
  assert.equal(report.summary.human.requests.acceptance, 4);
  assert.equal(report.summary.human.actions.acceptances, 4);
  assert.equal(report.summary.human.actions.total, 4);
  assert.equal(report.summary.dataComplete, true);
  assert.equal(report.summary.timing.complete, true);
  assert.equal(await invoke(['show', run.id]), 0);
  assert.equal(JSON.parse(output.pop()!).status, 'completed');
  assert.equal(await invoke(['events', run.id, '--after', '0']), 0);
  assert.ok(JSON.parse(output.pop()!).some((event: { type: string }) => event.type === 'workflow.completed'));
  assert.equal(await invoke(['rework', run.id, '--node', 'requirements', '--attempt', first, '--note', '调整范围']), 0);
  const invalidated = JSON.parse(output.pop()!) as WorkflowRun;
  assert.ok(invalidated.nodes.every(node => !node.currentAttemptId));
  assert.equal(await invoke(['accept', run.id, '--node', 'requirements', '--attempt', first, '--note', '迟到验收']), 1);
  assert.equal(await invoke(['resume', run.id, '--demo']), 0);
  const next = JSON.parse(output.pop()!) as WorkflowRun;
  assert.equal(next.status, 'waiting_acceptance');
  assert.notEqual(next.nodes[0].currentAttemptId, first);
  assert.ok(errors.some(line => line.includes('过期')));
});

test('workflow report needs no model or valid config, does not alter workspace files and validates arguments', async t => {
  const store = await fixture(t);
  const output: string[] = [];
  const errors: string[] = [];
  const io = { out: (line: string) => { output.push(line); }, err: (line: string) => { errors.push(line); } };
  const args = ['workflow', 'report'];
  assert.equal(await main(['workflow', 'run', '--file', 'examples/workflows/demo.json', '--workspace', store.workspace, '--demo', '--json'], io), 0);
  const run = JSON.parse(output.pop()!) as WorkflowRun;
  await writeFile(path.join(store.directory, 'config.json'), 'invalid config deliberately ignored by reports');
  const snapshot = async (): Promise<string> => {
    const files = (await readdir(store.workspace, { recursive: true })).sort();
    const contents = [];
    for (const file of files) {
      const absolute = path.join(store.workspace, file);
      if ((await stat(absolute)).isFile()) contents.push([file, await readFile(absolute, 'utf8')]);
    }
    return JSON.stringify(contents);
  };
  const before = await snapshot();
  assert.equal(await main([...args, run.id, '--workspace', store.workspace, '--json'], io), 0);
  assert.equal((JSON.parse(output.pop()!) as WorkflowReport).summary.human.requests.acceptance, 1);
  assert.equal(await main([...args, run.id, '--workspace', store.workspace], io), 0);
  assert.ok(output.some(line => line.includes('当前尝试')));
  assert.equal(await snapshot(), before);
  assert.equal(await main([...args, '--workspace', store.workspace], io), 1);
  assert.equal(await main([...args, run.id, '--workspace', store.workspace, '--demo'], io), 1);
  const absent = path.join(store.workspace, 'absent');
  assert.equal(await main([...args, run.id, '--workspace', absent], io), 1);
  await assert.rejects(stat(absent), { code: 'ENOENT' });
});

test('workflow CLI validates arguments and supports key-free definition creation and listing', async t => {
  const store = await fixture(t);
  const output: string[] = [];
  const io = { out: (line: string) => { output.push(line); }, err: (_line: string) => undefined };
  const invoke = (args: string[]) => main(['workflow', ...args, '--workspace', store.workspace, '--json'], io);
  assert.equal(await invoke(['create', '--file', 'examples/workflows/demo.json']), 0);
  const run = JSON.parse(output.pop()!);
  assert.equal(run.status, 'pending');
  assert.equal((await store.list()).length, 0);
  assert.equal(await invoke(['list']), 0);
  assert.equal(JSON.parse(output.pop()!).length, 1);
  assert.equal(await invoke(['accept', run.id, '--node', 'requirements', '--note', '缺少 attempt']), 1);
  assert.equal(await invoke(['run']), 1);
  assert.equal(await invoke(['list', '--demo']), 1);
  assert.equal(await invoke(['resume']), 1);
});

test('workflow show prints the current failed node reason while JSON remains structured', async t => {
  const store = await fixture(t);
  const reason = '模型服务返回 HTTP 400；服务端提示 reasoning_content 不符合要求';
  const engine = new WorkflowEngine(localServices, store, () => new ScriptedProvider([() => { throw new Error(reason); }]));
  const created = await engine.create({ version: 1, name: 'failure', nodes: [{ id: 'requirements', kind: 'requirements', goal: '整理需求' }] });
  assert.equal((await engine.run(created.id)).status, 'failed');
  const output: string[] = [];
  const errors: string[] = [];
  const io = { out: (line: string) => { output.push(line); }, err: (line: string) => { errors.push(line); } };
  const args = ['workflow', 'show', created.id, '--workspace', store.workspace];
  assert.equal(await main(args, io), 0);
  assert.ok(errors.includes(`  requirements: ${reason}`));
  errors.length = 0;
  assert.equal(await main([...args, '--json'], io), 0);
  assert.equal(currentAttempt((JSON.parse(output.pop()!) as WorkflowRun).nodes[0])!.error, reason);
  assert.deepEqual(errors, []);
});
