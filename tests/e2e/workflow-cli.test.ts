import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '@taskweave/cli';
import { currentAttempt } from '@taskweave/core';
import { fixture } from '../helpers.ts';
import type { WorkflowRun } from '@taskweave/contracts';

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
