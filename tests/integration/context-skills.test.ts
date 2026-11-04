import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localServices, Workspace } from '@taskweave/adapters';
import { TaskEngine, TaskReviewer, WorkflowEngine, currentAttempt, parseConfig, configHash, sha256, loadSkill, selectSkills, executeTool, buildContext, recordSummary, installSummary, summaryValid, assertHandoff, finalizeSummary } from '@taskweave/core';
import { fixture, ScriptedProvider, tool, turn } from '../helpers.ts';

const skillFile = 'skills/doc-style/SKILL.md';
const skillText = '---\nname: doc-style\ndescription: 文档规范\nversion: 1.0.0\n---\n使用约定的章节：目标、用法、限制。';
const skillConfig = () => parseConfig({ version: 1, skills: { 'doc-style': { path: skillFile }, broken: { path: 'missing/SKILL.md' } } });
async function setupSkill(root: string) {
  await mkdir(path.join(root, 'skills/doc-style'), { recursive: true });
  await writeFile(path.join(root, skillFile), skillText);
}
const summaryArgs = { facts: [{ text: '需要交付文档', evidence: [{ kind: 'goal' }] }], decisions: [], constraints: [], open_questions: [] };

test('omitted v0.4 config fields preserve the v0.3 fingerprint and invalid options are rejected', () => {
  const config = parseConfig({ version: 1 });
  assert.equal(configHash(config), sha256(JSON.stringify({ version: 1, checks: {}, validation: {} })));
  for (const extra of [{ skills: { invalid: { path: '../SKILL.md' } } }, { skills: { 'bad id': { path: 'SKILL.md' } } }, { context: { maxCharacters: 3999 } }, { context: { maxCharacters: 200001 } }]) assert.throws(() => parseConfig({ version: 1, ...extra }));
});

test('Skills load only explicit selections, bind content hashes and cannot expand tools', async t => {
  const store = await fixture(t); await setupSkill(store.workspace);
  const config = skillConfig();
  const provider = new ScriptedProvider([messages => {
    assert.match(JSON.stringify(messages), /约定的章节/);
    assert.equal(messages[0].role, 'system');
    return turn();
  }]);
  const engine = new TaskEngine(localServices, store, provider, config);
  const task = await engine.create({ kind: 'document', goal: '生成文档', skillIds: ['doc-style'] });
  assert.equal(task.skills?.[0].sha256, sha256(skillText));
  const result = await engine.run(task.id);
  assert.equal(result.status, 'waiting_acceptance');
  assert.equal(result.summary?.kind, 'extractive');
  const workspace = new Workspace(store.workspace);
  const blocked = await executeTool('write_file', JSON.stringify({ path: './skills/doc-style/SKILL.md', content: 'rewrite', expected_sha256: sha256(skillText) }), { task, store, services: localServices, workspace, config, callKey: 'protected', signal: new AbortController().signal });
  assert.equal(blocked.error?.code, 'SKILL_READ_ONLY');
  const unknown = await executeTool('shell', '{}', { task, store, services: localServices, workspace, config, callKey: 'shell', signal: new AbortController().signal });
  assert.equal(unknown.error?.code, 'UNKNOWN_TOOL');
  await assert.rejects(selectSkills(workspace, config, ['doc-style', 'doc-style']), /最多/);
  await assert.rejects(selectSkills(workspace, config, ['unregistered']), /未注册/);
  await writeFile(path.join(store.workspace, skillFile), skillText.replace('1.0.0', '1.0.1'));
  const rejected = await new TaskReviewer(localServices, store, config).review(task.id, 'accepted', '核对');
  assert.equal(rejected.status, 'failed'); assert.match(rejected.error!, /Skill.*变化/);
  assert.notEqual(rejected.approval?.decision, 'accepted');
});

test('changed Skill blocks resume before a pending write and restoring the binding permits recovery', async t => {
  const store = await fixture(t); await setupSkill(store.workspace);
  const config = skillConfig();
  const provider = new ScriptedProvider([
    () => turn(tool('ask_user', { question: '继续？' }, 'ask'), tool('write_file', { path: 'result.md', content: 'result', expected_sha256: null }, 'write')),
    () => turn()
  ]);
  const engine = new TaskEngine(localServices, store, provider, config);
  const task = await engine.create({ kind: 'document', goal: '文档', skillIds: ['doc-style'] });
  assert.equal((await engine.run(task.id)).status, 'waiting_input');
  await writeFile(path.join(store.workspace, skillFile), skillText + '\nchanged');
  const blocked = await engine.run(task.id, { answer: '继续' });
  assert.equal(blocked.status, 'failed'); assert.match(blocked.error!, /Skill.*变化/);
  assert.equal((await new Workspace(store.workspace).walk()).files.includes('result.md'), false);
  await writeFile(path.join(store.workspace, skillFile), skillText);
  // The user's answer was checkpointed before the failed version check; no repeated answer needed.
  assert.equal((await engine.run(task.id)).status, 'waiting_acceptance');
});

test('Skill frontmatter is bounded metadata, not arbitrary YAML or executable configuration', async t => {
  const store = await fixture(t); await setupSkill(store.workspace);
  for (const text of [skillText.replace('version: 1.0.0', 'tools: shell'), skillText.replace('name: doc-style', 'name: other'), skillText.replace('description: 文档规范', 'description: |\n  multiline'), skillText + 'x'.repeat(12_000)]) {
    await writeFile(path.join(store.workspace, skillFile), text);
    await assert.rejects(loadSkill(new Workspace(store.workspace), skillConfig(), 'doc-style'));
  }
});

test('model summaries retain evidence and invalidate when an artifact or source message changes', async t => {
  const store = await fixture(t); const workspace = new Workspace(store.workspace);
  const provider = new ScriptedProvider([
    () => turn(tool('write_file', { path: 'result.md', content: 'document', expected_sha256: null }, 'write')),
    () => turn(tool('record_summary', { ...summaryArgs, decisions: [{ text: '选择文档形式', evidence: [{ kind: 'tool', call_id: 'write' }, { kind: 'artifact', path: 'result.md', sha256: sha256('document') }] }] }, 'summary')),
    () => turn()
  ]);
  const engine = new TaskEngine(localServices, store, provider);
  const result = await engine.run((await engine.create({ kind: 'document', goal: '需要交付文档' })).id);
  assert.equal(result.status, 'waiting_acceptance'); assert.equal(result.summary?.kind, 'model');
  assert.equal(result.summary?.decisions[0].evidence.length, 2);
  assert.equal(await summaryValid(result, result.summary!, workspace), true);
  assert.ok(result.summary!.outcome?.evidence.some(ref => ref.kind === 'answer'));
  await writeFile(path.join(store.workspace, 'result.md'), 'modified');
  assert.equal(await summaryValid(result, result.summary!, workspace), false);
  assert.equal((await finalizeSummary(result, workspace)).kind, 'extractive');
  assert.ok(result.summaryHistory?.some(summary => summary.kind === 'model'));
});

test('summary rejects fabricated evidence and does not claim to cover its own unfinished round', async t => {
  const store = await fixture(t);
  const task = await new TaskEngine(localServices, store, new ScriptedProvider([])).create({ kind: 'document', goal: '目标' });
  task.messages.push({ role: 'assistant', content: null, tool_calls: [tool('list_files', {}, 'seen')] }, { role: 'tool', tool_call_id: 'seen', content: '[]' }, { role: 'assistant', content: null, tool_calls: [tool('record_summary', summaryArgs, 'summary')] });
  const workspace = new Workspace(store.workspace);
  const summary = await recordSummary(task, summaryArgs, workspace);
  assert.equal(summary.sourceMessageCount, 4);
  for (const ref of [{ kind: 'tool', call_id: 'nonexistent' }, { kind: 'artifact', path: 'missing', sha256: 'fake' }]) {
    await assert.rejects(recordSummary(task, { ...summaryArgs, facts: [{ text: 'fabricated', evidence: [ref] }] }, workspace));
  }
  await assert.rejects(recordSummary(task, { ...summaryArgs, facts: [{ text: 'no source', evidence: [] }] }, workspace));
  task.messages[3].content = 'changed';
  assert.equal(await summaryValid(task, summary, workspace), false);
});

test('summary compaction retains recent complete tool batches and the unmodified checkpoint', async t => {
  const store = await fixture(t);
  const task = await new TaskEngine(localServices, store, new ScriptedProvider([])).create({ kind: 'general', goal: '目标' });
  task.messages.push({ role: 'assistant', content: null, tool_calls: [tool('read_file', { path: 'big.md' }, 'old')], reasoning_content: '' }, { role: 'tool', tool_call_id: 'old', content: 'x'.repeat(15_000) });
  task.messages.push({ role: 'assistant', content: null, tool_calls: [tool('record_summary', summaryArgs, 'summary')] });
  installSummary(task, await recordSummary(task, summaryArgs, new Workspace(store.workspace)));
  task.messages.push({ role: 'tool', tool_call_id: 'summary', content: '{"ok":true}' }, { role: 'assistant', content: null, tool_calls: [tool('read_file', { path: 'next.md' }, 'next')], reasoning_content: '' }, { role: 'tool', tool_call_id: 'next', content: 'recent' });
  const original = JSON.stringify(task.messages);
  const context = buildContext(task, 8_000);
  assert.ok(context.archivedRounds > 0);
  assert.match(JSON.stringify(context.messages), /证据索引/);
  const recent = context.messages.find(message => message.role === 'assistant' && message.tool_calls?.[0].id === 'next')!;
  assert.equal(recent.reasoning_content, '');
  assert.ok(context.messages.some(message => message.role === 'tool' && message.tool_call_id === 'next'));
  assert.equal(JSON.stringify(task.messages), original);
  task.messages.push({ role: 'assistant', content: 'uncovered'.repeat(2_000) });
  assert.throws(() => buildContext(task, 8_000), /上下文预算/);
});

test('summary receipt restores the semantic side effect after a crash without re-execution', async t => {
  const store = await fixture(t);
  const provider = new ScriptedProvider([() => turn(tool('record_summary', summaryArgs, 'summary')), () => turn()]);
  const engine = new TaskEngine(localServices, store, provider);
  const task = await engine.create({ kind: 'document', goal: '文档' });
  const original = store.saveReceipt.bind(store);
  let crash = true;
  store.saveReceipt = async (...args) => { await original(...args); if (crash) { crash = false; throw new Error('crash after receipt'); } };
  assert.equal((await engine.run(task.id)).status, 'failed');
  assert.equal((await store.load(task.id)).summary, undefined);
  const resumed = await engine.run(task.id);
  assert.equal(resumed.summary?.kind, 'model');
  assert.ok((await store.events(task.id)).some(event => event.type === 'summary.recorded' && event.data.replayed === true));
});

function workflowSpec() {
  return { version: 1, name: 'handoff', nodes: [
    { id: 'req', kind: 'requirements', goal: '生成需求', validationPolicy: { rules: [{ type: 'exists', path: 'req.md' }], requireApproval: false } },
    { id: 'docs', kind: 'document', goal: '生成文档', dependsOn: ['req'] }
  ] };
}

test('handoff binds upstream summary, validation, task and attempt; file mutation blocks downstream recovery', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, node => node.id === 'req' ? new ScriptedProvider([
    () => turn(tool('write_file', { path: 'req.md', content: 'requirements', expected_sha256: null })), () => turn()
  ]) : new ScriptedProvider([messages => {
    assert.match(JSON.stringify(messages), /结构化上下文交接包/);
    return turn(tool('write_file', { path: './req.md', content: 'changed', expected_sha256: sha256('requirements') }, 'protected'), tool('ask_user', { question: '确认？' }, 'ask'));
  }, () => turn()]));
  const waiting = await engine.run((await engine.create(workflowSpec())).id);
  assert.equal(waiting.status, 'waiting_input');
  const attempt = currentAttempt(waiting.nodes[1])!;
  const task = await store.load(attempt.taskId);
  const source = task.handoff!.sources[0];
  assert.equal(source.attemptId, waiting.nodes[0].currentAttemptId);
  assert.equal(source.taskId, currentAttempt(waiting.nodes[0])!.taskId);
  assert.equal(source.summary.kind, 'extractive');
  assert.equal(source.validationId, (await store.load(source.taskId)).validation!.id);
  const observation = task.messages.find(message => message.role === 'tool' && message.tool_call_id === 'protected')!;
  assert.equal(JSON.parse(observation.content!).error.code, 'HANDOFF_READ_ONLY');
  await writeFile(path.join(store.workspace, 'req.md'), 'changed externally');
  const blocked = await engine.answer(waiting.id, 'docs', attempt.id, '确认');
  assert.equal(blocked.status, 'failed');
  assert.match(currentAttempt(blocked.nodes[1])!.error!, /上游交接/);
});

test('rework creates a fresh handoff and stale task identities cannot write', async t => {
  const store = await fixture(t);
  const engine = new WorkflowEngine(localServices, store, node => new ScriptedProvider(node.id === 'req' ? [
    async () => {
      const workspace = new Workspace(store.workspace); let hash: string | null = null;
      try { hash = (await workspace.read('req.md')).hash; } catch {}
      return turn(tool('write_file', { path: 'req.md', content: 'requirements', expected_sha256: hash }));
    }, () => turn()
  ] : [() => turn()]));
  let run = await engine.run((await engine.create(workflowSpec())).id);
  const old = await store.load(currentAttempt(run.nodes[1])!.taskId);
  const oldSource = old.handoff!.sources[0].attemptId;
  await engine.rework(run.id, 'req', currentAttempt(run.nodes[0])!.id, '调整需求');
  run = await engine.run(run.id);
  const fresh = await store.load(currentAttempt(run.nodes[1])!.taskId);
  assert.notEqual(fresh.handoff!.sources[0].attemptId, oldSource);
  assert.notEqual(fresh.handoff!.digest, old.handoff!.digest);
  await assert.rejects(assertHandoff(store, new Workspace(store.workspace), old), /上游交接/);
  const corrupted = structuredClone(fresh); corrupted.handoff!.sources[0].summary.goal = 'tampered';
  await assert.rejects(assertHandoff(store, new Workspace(store.workspace), corrupted), /上游交接/);
});

test('oversized handoffs fail explicitly before requesting a downstream model instead of truncating JSON', async t => {
  const store = await fixture(t); await writeFile(path.join(store.workspace, 'proof.md'), 'proof');
  const statement = { text: '已记录的目标说明'.repeat(70), evidence: [{ kind: 'goal' }] };
  const args = { facts: Array(8).fill(statement), decisions: Array(8).fill(statement), constraints: [], open_questions: [] };
  const upstream = ['a', 'b', 'c', 'd'];
  let downstreamCalls = 0;
  const engine = new WorkflowEngine(localServices, store, node => node.id === 'target'
    ? { id: 'fixture:v1', async complete() { downstreamCalls++; return turn(); } }
    : new ScriptedProvider([() => turn(tool('record_summary', args, 'summary')), () => turn()]));
  const run = await engine.run((await engine.create({ version: 1, name: 'bounded', nodes: [
    ...upstream.map(id => ({ id, kind: 'general', goal: '已记录的目标说明', validationPolicy: { rules: [{ type: 'exists', path: 'proof.md' }], requireApproval: false } })),
    { id: 'target', kind: 'document', goal: '合并交接', dependsOn: upstream }
  ] })).id);
  assert.equal(run.status, 'failed'); assert.match(run.error!, /交接超过/);
  assert.equal(downstreamCalls, 0);
  assert.ok(run.nodes.slice(0, 4).every(node => node.status === 'succeeded'));
});
