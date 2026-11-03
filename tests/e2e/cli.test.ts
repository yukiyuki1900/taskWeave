import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { main } from '@taskweave/cli';
import { TASK_KINDS } from '@taskweave/core/types';
import { fixture } from '../helpers.ts';

test('CLI supports all task kinds without keys and produces machine-readable results', async t => {
  for (const kind of TASK_KINDS) {
    const store = await fixture(t);
    const output: string[] = [];
    const io = { out: (line: string) => { output.push(line); }, err: (_line: string) => undefined };
    assert.equal(await main(['run', '--demo', '--kind', kind, '--prompt', '演示任务', '--workspace', store.workspace, '--json'], io), 0);
    const task = JSON.parse(output.pop()!);
    assert.equal(task.status, 'waiting_acceptance');
    assert.equal(task.artifacts.length, 1);
    assert.equal(task.provider, 'demo:v1');
    assert.equal(await main(['list', '--workspace', store.workspace, '--json'], io), 0);
    assert.ok(JSON.parse(output.pop()!).some((row: { id: string }) => row.id === task.id));
    assert.equal(await main(['events', task.id, '--workspace', store.workspace, '--after', '1', '--json'], io), 0);
    assert.ok(JSON.parse(output.pop()!).every((event: { seq: number }) => event.seq > 1));
  }
});

test('CLI validates commands and the executable launcher loads TypeScript', async () => {
  const errors: string[] = [];
  const io = { out: (_line: string) => undefined, err: (line: string) => { errors.push(line); } };
  assert.equal(await main(['run', '--kind', 'invalid', '--prompt', 'x'], io), 1);
  assert.equal(await main(['resume'], io), 1);
  assert.equal(await main(['list', '--prompt', 'x'], io), 1);
  assert.equal(errors.length, 3);
  const { stdout } = await promisify(execFile)(process.execPath, ['bin/taskweave.mjs', '--help'], { cwd: process.cwd() });
  assert.match(stdout, /TaskWeave/);
  assert.match(stdout, /requirements/);
});
