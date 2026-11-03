import { createTask } from '@taskweave/core';
import { localServices } from '@taskweave/adapters';
import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runCheck } from '@taskweave/core';
import { parseConfig } from '@taskweave/core';
import { loadConfig } from '@taskweave/adapters';
import { TaskEngine } from '@taskweave/core';
import { Workspace } from '@taskweave/adapters';
import { availableTools, executeTool } from '@taskweave/core';
import { fixture, ScriptedProvider, tool, turn } from '../helpers.ts';

test('run_checks accepts names only, reports failed exit codes and does not inherit model credentials', async t => {
  const store = await fixture(t);
  const config = parseConfig({ version: 1, checks: { verify: { command: process.execPath, args: ['-e', 'console.log(Object.hasOwn(process.env,"TASKWEAVE_API_KEY")); process.exit(2)'] } } });
  const task = await store.withLock(() => createTask(store, { kind: 'code', goal: '验证' }, 'fixture:v1'));
  const ctx = { store, task, services: localServices, workspace: new Workspace(store.workspace), callKey: '1:x', signal: new AbortController().signal, config };
  const result = await executeTool('run_checks', JSON.stringify({ checks: ['verify'] }), ctx);
  assert.equal(result.ok, false);
  const check = (result.data as { checks: Array<{ status: string; stdout: string; exitCode: number }> }).checks[0];
  assert.equal(check.status, 'failed'); assert.equal(check.exitCode, 2); assert.match(check.stdout, /false/);
  assert.equal((await executeTool('run_checks', '{"checks":["verify"],"args":["malicious"]}', ctx)).error?.code, 'INVALID_ARGUMENTS');
  assert.equal((await executeTool('run_checks', '{"checks":["toString"]}', ctx)).error?.code, 'CHECK_NOT_ALLOWED');
  assert.equal(availableTools(parseConfig({ version: 1 })).some(tool => tool.function.name === 'run_checks'), false);
});

test('command receipts are reused; interrupted unknown outcomes never automatically rerun', async t => {
  const store = await fixture(t);
  const config = parseConfig({ version: 1, checks: { once: { command: process.execPath, args: ['-e', 'require("node:fs").appendFileSync("effects.txt","x")'] } } });
  const task = await store.withLock(() => createTask(store, { kind: 'code', goal: '验证' }, 'fixture:v1'));
  const options = { runner: localServices.checkRunner, store, taskId: task.id, key: 'stable', config, signal: new AbortController().signal };
  assert.equal((await runCheck('once', options)).status, 'passed');
  assert.equal((await runCheck('once', options)).status, 'passed');
  assert.equal(await readFile(path.join(store.workspace, 'effects.txt'), 'utf8'), 'x');
  await store.saveCheckRecord(task.id, 'interrupted:once', { state: 'started' });
  assert.equal((await runCheck('once', { ...options, key: 'interrupted' })).status, 'unknown');
  assert.equal(await readFile(path.join(store.workspace, 'effects.txt'), 'utf8'), 'x');
});

test('commands enforce output limits, timeout, cancellation and missing-executable errors', async t => {
  const store = await fixture(t);
  const task = await store.withLock(() => createTask(store, { kind: 'tests', goal: '边界验证' }, 'fixture:v1'));
  const config = parseConfig({ version: 1, checks: {
    noisy: { command: process.execPath, args: ['-e', 'console.log("x".repeat(10000))'], maxOutputBytes: 64 },
    slow: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 },
    cancel: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
    missing: { command: 'taskweave-executable-that-does-not-exist' }
  } });
  const options = { runner: localServices.checkRunner, store, taskId: task.id, key: 'edges', config, signal: new AbortController().signal };
  const noisy = await runCheck('noisy', options);
  assert.equal(noisy.status, 'output_limit');
  assert.ok(Buffer.byteLength(noisy.stdout + noisy.stderr) <= 64);
  assert.equal((await runCheck('slow', options)).status, 'timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timer));
  assert.equal((await runCheck('cancel', { ...options, signal: controller.signal })).status, 'cancelled');
  assert.equal((await runCheck('missing', options)).status, 'failed');
});

test('real check failures are fed back to the model and final validation reruns the command', async t => {
  const store = await fixture(t);
  const config = parseConfig({ version: 1, checks: { verify: { command: process.execPath, args: ['-e', 'process.exit(require("node:fs").existsSync("fixed.txt")?0:1)'] } }, validation: { code: { checks: ['verify'], requireApproval: false } } });
  const engine = new TaskEngine(localServices, store, new ScriptedProvider([
    () => turn(tool('run_checks', { checks: ['verify'] })),
    messages => {
      assert.equal(JSON.parse(messages.at(-1)!.content!).data.checks[0].status, 'failed');
      return turn(tool('write_file', { path: 'fixed.txt', content: 'fixed', expected_sha256: null }));
    }, () => turn()
  ]), config);
  const task = await engine.create({ kind: 'code', goal: '修正检查' });
  const result = await engine.run(task.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.validation!.items.find(item => item.check)?.check?.exitCode, 0);
});

test('config and command working directories reject symbolic links', async t => {
  const store = await fixture(t);
  await writeFile(path.join(store.workspace, 'config.json'), '{"version":1}');
  await symlink(path.join(store.workspace, 'config.json'), path.join(store.directory, 'config.json'));
  await assert.rejects(loadConfig(store.workspace), /配置无效/);
  await symlink(store.workspace, path.join(store.workspace, 'alias'));
  const task = await store.withLock(() => createTask(store, { kind: 'code', goal: '验证' }, 'fixture:v1'));
  const config = parseConfig({ version: 1, checks: { test: { command: process.execPath, cwd: 'alias' } } });
  await assert.rejects(runCheck('test', { runner: localServices.checkRunner, store, taskId: task.id, key: 'cwd', config, signal: new AbortController().signal }), /符号链接/);
});

test('POSIX timeout terminates descendants even when the parent exits on TERM', { skip: process.platform === 'win32' }, async t => {
  const store = await fixture(t);
  const task = await store.withLock(() => createTask(store, { kind: 'tests', goal: '清理后代进程' }, 'fixture:v1'));
  const descendant = 'process.on("SIGTERM",()=>{});setTimeout(()=>require("node:fs").writeFileSync("leaked.txt","alive"),1000);setInterval(()=>{},1000)';
  const parent = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
  const config = parseConfig({ version: 1, checks: { tree: { command: process.execPath, args: ['-e', parent], timeoutMs: 200 } } });
  assert.equal((await runCheck('tree', { runner: localServices.checkRunner, store, taskId: task.id, key: 'tree', config, signal: new AbortController().signal })).status, 'timeout');
  await new Promise(resolve => setTimeout(resolve, 1100));
  await assert.rejects(readFile(path.join(store.workspace, 'leaked.txt')), { code: 'ENOENT' });
});

test('large command observations are clipped for the model while execution records retain evidence', async t => {
  const store = await fixture(t);
  const config = parseConfig({ version: 1, checks: { verbose: { command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(30000))'], maxOutputBytes: 40000 } } });
  const task = await store.withLock(() => createTask(store, { kind: 'tests', goal: '输出预算' }, 'fixture:v1'));
  const result = await executeTool('run_checks', '{"checks":["verbose"]}', { store, task, services: localServices, workspace: new Workspace(store.workspace), config, callKey: 'large', signal: new AbortController().signal });
  const observation = (result.data as { checks: Array<{ stdout: string; outputTruncated: boolean }> }).checks[0];
  assert.equal(result.ok, true);
  assert.equal(observation.stdout.length, 16384);
  assert.equal(observation.outputTruncated, true);
  const record = await store.checkRecord<{ result: { stdout: string } }>(task.id, 'tool:large:verbose');
  assert.equal(record!.result.stdout.length, 30000);
});
