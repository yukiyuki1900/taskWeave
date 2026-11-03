import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DemoProvider } from '@taskweave/adapters';
import { evaluate, loadSuite, parseSuite } from '@taskweave/evaluation';
import { main } from '@taskweave/cli';
import { fixture, ScriptedProvider, tool, turn } from '../helpers.ts';

test('evaluation isolates case workspaces and persists honest pass, cost and failure metrics', async t => {
  const store = await fixture(t);
  const suite = parseSuite({ version: 1, name: 'fixtures', cases: [
    { id: 'pass', kind: 'document', goal: '写产物', files: { 'brief.md': 'original' }, validation: { rules: [{ type: 'contains', path: 'result.md', text: 'verified' }], requireApproval: false } },
    { id: 'fail', kind: 'code', goal: '缺少产物', validation: { rules: [{ type: 'exists', path: 'result.md' }], requireApproval: false } }
  ] });
  const report = await evaluate(suite, {
    workspace: store.workspace, demo: false,
    provider: kind => kind === 'document' ? new ScriptedProvider([
      () => turn(tool('write_file', { path: 'result.md', content: 'verified', expected_sha256: null })), () => turn()
    ]) : new ScriptedProvider([() => turn()])
  });
  assert.equal(report.summary.executed, 2);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.passRate, 0.5);
  assert.equal(report.summary.inputTokens, 30);
  assert.equal(report.summary.outputTokens, 15);
  assert.equal(report.summary.toolCalls, 1);
  assert.equal(report.cases[1].failure, 'validation');
  assert.equal(report.cases[1].status, 'validation_failed');
  assert.equal(await readFile(path.join(report.runDirectory, 'pass', 'brief.md'), 'utf8'), 'original');
  assert.deepEqual(JSON.parse(await readFile(path.join(report.runDirectory, 'report.json'), 'utf8')), report);
});

test('waiting for human input counts as an intervention, never as a passed evaluation', async t => {
  const store = await fixture(t);
  const suite = parseSuite({ version: 1, name: 'human', cases: [{ id: 'wait', kind: 'requirements', goal: '询问目标', validation: {} }] });
  const report = await evaluate(suite, { workspace: store.workspace, demo: false, provider: () => new ScriptedProvider([() => turn(tool('ask_user', { question: '目标用户是谁？' }))]) });
  assert.equal(report.summary.passed, 0);
  assert.equal(report.summary.humanInterventions, 1);
  assert.equal(report.cases[0].status, 'waiting_input');
});

test('the shipped smoke suite exercises four kinds while the model baseline contains twenty cases', async t => {
  const store = await fixture(t);
  const suite = await loadSuite('examples/evaluation/demo.json');
  const report = await evaluate(suite, { workspace: store.workspace, demo: true, provider: kind => new DemoProvider(kind) });
  assert.equal(report.mode, 'demo');
  assert.equal(report.summary.passed, 4);
  assert.equal(report.summary.inputTokens, 0);
  const baseline = await loadSuite('examples/evaluation/baseline.json');
  assert.equal(baseline.cases.length, 20);
  assert.equal(baseline.cases.filter(item => item.kind === 'code').length, 5);
});

test('evaluation rejects duplicate cases, unsafe file paths and misleading automatic policies', async t => {
  const store = await fixture(t);
  const one = { id: 'one', kind: 'document', goal: 'goal', validation: {} };
  assert.throws(() => parseSuite({ version: 1, name: 'duplicate', cases: [one, one] }), /评测集无效/);
  assert.throws(() => parseSuite({ version: 1, name: 'empty', cases: [{ ...one, validation: { requireApproval: false } }] }), /配置无效/);
  const suite = parseSuite({ version: 1, name: 'unsafe', cases: [{ ...one, files: { '../escape.md': 'bad' } }] });
  const report = await evaluate(suite, { workspace: store.workspace, demo: true, provider: kind => new DemoProvider(kind) });
  assert.equal(report.summary.passed, 0);
  assert.match(report.cases[0].failure!, /禁止访问/);
});

test('shipped code assertions reject original bugs and accept known-correct implementations', async t => {
  const store = await fixture(t);
  const baseline = await loadSuite('examples/evaluation/baseline.json');
  const suite = { ...baseline, cases: baseline.cases.filter(item => item.kind === 'code') };
  const broken = await evaluate(suite, { workspace: store.workspace, demo: false, provider: () => new ScriptedProvider([() => turn()]) });
  assert.equal(broken.summary.passed, 0);
  const source = 'export const add=(a,b)=>a+b; export const normalizeTitle=s=>s.trim().replace(/\\s+/g," "); export const clamp=(x,min,max)=>Math.min(max,Math.max(min,x)); export const unique=xs=>[...new Set(xs)]; export const safeDivide=(a,b)=>b===0?null:a/b;';
  const fixed = await evaluate(suite, {
    workspace: store.workspace, demo: false,
    provider: () => new ScriptedProvider([
      () => turn(tool('read_file', { path: 'answer.mjs' })),
      messages => turn(tool('write_file', { path: 'answer.mjs', content: source, expected_sha256: JSON.parse(messages.at(-1)!.content!).data.sha256 })),
      () => turn()
    ])
  });
  assert.equal(fixed.summary.passed, 5);
});

test('CLI eval emits a report and a distinct demo mode', async t => {
  const store = await fixture(t);
  const output: string[] = [];
  const io = { out: (line: string) => { output.push(line); }, err: (_line: string) => undefined };
  assert.equal(await main(['eval', '--suite', 'examples/evaluation/demo.json', '--demo', '--limit', '1', '--workspace', store.workspace], io), 0);
  const report = JSON.parse(output.pop()!);
  assert.equal(report.mode, 'demo');
  assert.equal(report.planned, 1);
  assert.equal(report.summary.passed, 1);
});
