import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore, localServices } from '@taskweave/adapters';
import { TaskEngine, WorkflowEngine, currentAttempt, parseConfig } from '@taskweave/core';
import { createLocalReadApi } from '@taskweave/server';
import type {
  ApiResponse,
  DemoFrame,
  DemoRecording,
  DemoReply,
  EventPage,
  TaskView,
  WorkflowRun,
} from '@taskweave/contracts';
import { ShowcaseProvider } from './provider.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:4310';
/** Creates a NEW workspace only. Captures public HTTP views through the real read API. */
export async function recordShowcase(workspace: string): Promise<DemoRecording> {
  await mkdir(workspace); // EEXIST protects user data; no overwrite/resume mode.
  await mkdir(path.join(workspace, '.taskweave'));
  await mkdir(path.join(workspace, 'skills', 'doc-style'), { recursive: true });
  const configText = await readFile(path.join(root, 'examples/showcase/config.json'), 'utf8');
  await writeFile(path.join(workspace, '.taskweave/config.json'), configText);
  await copyFile(
    path.join(root, 'examples/context/skills/doc-style/SKILL.md'),
    path.join(workspace, 'skills/doc-style/SKILL.md'),
  );
  const config = parseConfig(JSON.parse(configText));
  const store = await TaskStore.open(workspace);
  const overview = new TaskEngine(
    localServices,
    store,
    new ShowcaseProvider({ id: 'overview', dependsOn: [] }, 1),
    config,
  );
  await overview.run(
    (
      await overview.create({
        kind: 'document',
        title: '独立任务：演示说明',
        goal: '生成固定演示说明，明确不调用模型。',
        validationPolicy: {
          rules: [{ type: 'exists', path: 'artifacts/overview.md' }],
          checks: [],
          requireApproval: false,
        },
      })
    ).id,
  );
  let revision = 1;
  let broken = true;
  const engine = new WorkflowEngine(
    localServices,
    store,
    (node) => new ShowcaseProvider(node, revision, node.id === 'implementation' && broken),
    config,
  );
  let run = await engine.create(
    JSON.parse(await readFile(path.join(root, 'examples/showcase/delivery.json'), 'utf8')),
  );
  const frames: DemoFrame[] = [];
  async function capture(id: string, label: string, description: string) {
    const recordedAt = new Date().toISOString();
    const api = await createLocalReadApi(workspace, {
      origin,
      name: 'TaskWeave · 脚本演示',
      clock: () => recordedAt,
    });
    const responses: Record<string, DemoReply> = {};
    async function get(key: string, route = key) {
      const response = await api(new Request(origin + route));
      const body = await response.json();
      responses[key] = { status: response.status, body };
      return body;
    }
    async function events(scope: 'task' | 'workflow', id: string) {
      const key = `/api/v1/events?scope=${scope}&id=${id}`;
      let after = 0;
      let first: ApiResponse<EventPage> | undefined;
      for (;;) {
        const body = (await get(key, `${key}&after=${after}&limit=200`)) as ApiResponse<EventPage>;
        assert.equal(responses[key].status, 200);
        assert.equal(body.data.complete, true);
        if (!first) first = structuredClone(body);
        else first.data.items.push(...body.data.items);
        after = body.data.nextAfter;
        if (!body.data.hasMore) {
          first.data.nextAfter = after;
          first.data.hasMore = false;
          break;
        }
      }
      responses[key].body = first!;
    }
    await get('/api/v1/workspace');
    await get('/api/v1/workflows', '/api/v1/workflows?limit=100');
    await get(`/api/v1/workflows/${run.id}`);
    await get(`/api/v1/workflows/${run.id}/report`);
    await get('/api/v1/tasks', '/api/v1/tasks?scope=all&limit=100');
    await events('workflow', run.id);
    for (const task of await store.list()) {
      const body = (await get(`/api/v1/tasks/${task.id}`)) as ApiResponse<TaskView>;
      assert.equal(responses[`/api/v1/tasks/${task.id}`].status, 200);
      await events('task', task.id);
      for (const artifact of body.data.artifacts)
        await get(`/api/v1/tasks/${task.id}/artifacts/${artifact.id}`);
    }
    for (const reply of Object.values(responses))
      assert.ok(
        reply.status === 200 || reply.status === 409,
        `unexpected public response ${reply.status}`,
      );
    frames.push({ id, label, description, recordedAt, responses });
  }
  function attempt(node: string) {
    return currentAttempt(run.nodes.find((item) => item.id === node)!)!.id;
  }
  async function review(node: string) {
    run = await engine.review(
      run.id,
      node,
      attempt(node),
      'accepted',
      '固定脚本代行确认，仅展示人工门禁协议，不代表真人评审。',
    );
  }
  await capture('created', '01 · 创建工作流', '四类节点共享执行内核，依赖尚未满足的节点保持阻塞。');
  run = await engine.run(run.id);
  assert.equal(run.status, 'waiting_acceptance');
  await capture(
    'requirements',
    '02 · 需求待确认',
    '需求产物通过结构检查后等待验收；确认由录制脚本代行。',
  );
  await review('requirements');
  assert.equal(run.status, 'failed');
  await capture(
    'failed',
    '03 · 独立验证失败',
    '固定脚本故意写入错误函数，实际 normalize-smoke 检查失败，下游不继续。',
  );
  run = await engine.rework(
    run.id,
    'implementation',
    attempt('implementation'),
    '固定脚本演示：修正标题规范化实现',
    true,
  );
  broken = false;
  await capture(
    'retry',
    '04 · 显式重试',
    '旧 attempt 标为过期，新 attempt 将携带新的任务身份执行。',
  );
  run = await engine.run(run.id);
  assert.equal(run.status, 'waiting_input');
  await capture(
    'input',
    '05 · 等待补充输入',
    '修正后的代码通过实际检查，测试节点通过 node:test；文档节点询问语言。',
  );
  run = await engine.answer(
    run.id,
    'documentation',
    attempt('documentation'),
    '使用中文。此回答由固定脚本提供。',
  );
  assert.equal(run.status, 'waiting_acceptance');
  await capture(
    'documentation',
    '06 · 文档待验收',
    '文档绑定 doc-style Skill，并保留直接上游交接、摘要、产物 hash 与验证记录。',
  );
  await review('documentation');
  assert.equal(run.status, 'completed');
  await capture(
    'completed',
    '07 · 首轮交付完成',
    '四个节点全部成功；Token 为 0，调用计数是脚本 Provider 回合，确认动作不是实际人力成本。',
  );
  run = await engine.rework(
    run.id,
    'requirements',
    attempt('requirements'),
    '补充换行和制表符的范围说明',
  );
  revision = 2;
  await capture(
    'rework',
    '08 · 上游返工',
    '已完成上游返工使下游结果传递失效，保留旧 attempt 的成本和证据。',
  );
  run = await engine.run(run.id);
  assert.equal(run.status, 'waiting_acceptance');
  await capture(
    'changed',
    '09 · 历史产物已变化',
    '修订需求覆盖同一路径后，旧 attempt 的产物接口实际返回 409；回放保留该错误。',
  );
  await review('requirements');
  assert.equal(run.status, 'waiting_input');
  await capture(
    'second-input',
    '10 · 新交接继续执行',
    '新 attempt 绑定新需求和来源身份，重新经过代码、测试和文档流程。',
  );
  run = await engine.answer(
    run.id,
    'documentation',
    attempt('documentation'),
    '中文，并保留更新后的范围。',
  );
  await capture(
    'second-review',
    '11 · 再次验收',
    '对新的文档 attempt 确认，旧验收不能代替新版本验收。',
  );
  await review('documentation');
  assert.equal(run.status, 'completed');
  await capture(
    'final',
    '12 · 最终交付',
    '查看全部/当前 attempt 统计、过期记录与交接链。此录制验证工程流程，不衡量真实模型表现。',
  );
  const recording: DemoRecording = {
    version: 1,
    provenance: 'scripted-runtime',
    name: '标题规范化交付全流程',
    description: '固定脚本实际运行 Runtime、工具、检查与门禁；未调用模型，人工动作由脚本代行。',
    runId: run.id,
    frames,
  };
  const serialized = JSON.stringify(recording);
  assert.equal(
    serialized.includes(path.resolve(workspace)),
    false,
    'public recording leaked workspace path',
  );
  return recording;
}
