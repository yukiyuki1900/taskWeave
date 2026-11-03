import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { TaskEngine, TaskReviewer } from '@taskweave/core';
import { localServices, TaskStore } from '@taskweave/adapters';
import { fixture } from '../helpers.ts';

test('v0.3 generated checkpoints recover into validation without regenerating their output', async t => {
  const store = await fixture(t);
  const checkpoint = JSON.parse(await readFile(new URL('../fixtures/v03-generated-checkpoint.json', import.meta.url), 'utf8'));
  checkpoint.task.workspace = store.workspace;
  await writeFile(path.join(store.directory, 'tasks', `${checkpoint.task.id}.json`), JSON.stringify(checkpoint.task));
  await writeFile(path.join(store.directory, 'events', `${checkpoint.task.id}.jsonl`), JSON.stringify(checkpoint.event) + '\n');
  for (const [file, content] of Object.entries(checkpoint.files)) await writeFile(path.join(store.workspace, file), content as string);
  const reopened = await TaskStore.open(store.workspace);
  const engine = new TaskEngine(localServices, reopened, {
    id: 'legacy:v03', async complete() { throw new Error('generated answer must not be regenerated'); }
  });
  assert.equal((await engine.run(checkpoint.task.id)).status, 'waiting_acceptance');
  const accepted = await new TaskReviewer(localServices, reopened).review(checkpoint.task.id, 'accepted', '核对已有说明');
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.steps, 1);
  assert.equal(await readFile(path.join(store.workspace, 'existing.md'), 'utf8'), checkpoint.files['existing.md']);
  const events = await reopened.events(checkpoint.task.id);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
});
