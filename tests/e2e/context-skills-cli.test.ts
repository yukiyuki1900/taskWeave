import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { main } from '@taskweave/cli';
import { localServices } from '@taskweave/adapters';
import { WorkflowEngine, currentAttempt } from '@taskweave/core';
import { fixture, ScriptedProvider, turn } from '../helpers.ts';

const sample = 'examples/context/skills/doc-style/SKILL.md';
async function prepare(root: string) {
  await mkdir(path.join(root, '.taskweave'), { recursive: true });
  await mkdir(path.join(root, 'skills/doc-style'), { recursive: true });
  await writeFile(path.join(root, 'skills/doc-style/SKILL.md'), await readFile(sample));
  await writeFile(path.join(root, '.taskweave/config.json'), JSON.stringify({ version: 1, skills: { 'doc-style': { path: 'skills/doc-style/SKILL.md' } } }));
}

test('Skill inspection works before task initialization and creates no runtime state', async t => {
  const store = await fixture(t); const root = path.join(store.workspace, 'fresh'); await prepare(root);
  const before = await readdir(root, { recursive: true }); const output: string[] = []; const errors: string[] = [];
  const io = { out: (text: string) => { output.push(text); }, err: (text: string) => { errors.push(text); } };
  assert.equal(await main(['skills', 'list', '--workspace', root, '--json'], io), 0);
  assert.equal(JSON.parse(output.pop()!)[0].version, '1.0.0');
  assert.equal(await main(['skills', 'show', 'doc-style', '--workspace', root, '--json'], io), 0);
  assert.match(JSON.parse(output.pop()!).content, /文档交付方法/);
  assert.equal(await main(['skills', 'show', 'missing', '--workspace', root], io), 1);
  assert.equal(await main(['skills', 'list', 'extra', '--workspace', root], io), 1);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
});

test('run binds explicit Skill, summary is read-only and resume cannot silently replace the selection', async t => {
  const store = await fixture(t); await prepare(store.workspace);
  const output: string[] = []; const errors: string[] = [];
  const io = { out: (text: string) => { output.push(text); }, err: (text: string) => { errors.push(text); } };
  assert.equal(await main(['run', '--demo', '--kind', 'document', '--prompt', '生成说明', '--skill', 'doc-style', '--workspace', store.workspace, '--json'], io), 0);
  const task = JSON.parse(output.pop()!); assert.equal(task.skills[0].id, 'doc-style');
  const file = path.join(store.directory, 'tasks', `${task.id}.json`); const before = await readFile(file, 'utf8');
  assert.equal(await main(['summary', task.id, '--workspace', store.workspace, '--json'], io), 0);
  const report = JSON.parse(output.pop()!); assert.equal(report.summary.kind, 'extractive'); assert.equal(report.evidenceCurrent, true);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(await main(['resume', task.id, '--skill', 'doc-style', '--workspace', store.workspace], io), 1);
  assert.equal(await main(['summary', '--workspace', store.workspace], io), 1);
  assert.equal(await main(['list', '--skill', 'doc-style', '--workspace', store.workspace], io), 1);
});

test('workflow node Skills are explicit and the shipped v0.4 configuration parses', async t => {
  const store = await fixture(t); await prepare(store.workspace);
  const raw = JSON.parse(await readFile('examples/context/config.json', 'utf8'));
  const workflow = JSON.parse(await readFile('examples/context/delivery.json', 'utf8'));
  assert.deepEqual(workflow.nodes.at(-1).skills, ['doc-style']);
  const engine = new WorkflowEngine(localServices, store, () => new ScriptedProvider([messages => {
    assert.match(JSON.stringify(messages), /doc-style@1.0.0/); return turn();
  }]), raw);
  const run = await engine.run((await engine.create({ version: 1, name: 'skill', nodes: [{ id: 'docs', kind: 'document', goal: '写文档', skills: ['doc-style'] }] })).id);
  assert.equal(run.status, 'waiting_acceptance');
  assert.equal((await store.load(currentAttempt(run.nodes[0])!.taskId)).skills?.[0].id, 'doc-style');
});
