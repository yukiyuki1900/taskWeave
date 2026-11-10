import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import data from '../../apps/web/src/demo/recording.json' with { type: 'json' };
import { createDemoTransport, parseRecording } from '../../apps/web/src/demo/transport.ts';
import { ReadClient } from '../../apps/web/src/data/client.ts';
import { recordShowcase } from '../../scripts/showcase/scenario.ts';
import { createDemoHost } from '../../scripts/showcase/host.ts';
import { fixture } from '../helpers.ts';
import type {
  ApiResponse,
  ArtifactContentView,
  ReportView,
  TaskView,
  WorkflowView,
} from '@taskweave/contracts';

const recording = parseRecording(data);
const reply = <T>(frame: number, key: string) =>
  recording.frames[frame].responses[key].body as ApiResponse<T>;
const workflow = (frame: number) =>
  reply<WorkflowView>(frame, `/api/v1/workflows/${recording.runId}`).data;

test('committed recording contains API-derived success, real failed checks, history, handoff and Skill without checkpoints', () => {
  assert.equal(recording.frames.length, 12);
  const first = workflow(2).nodes.find((node) => node.id === 'implementation')!.attempts[0];
  const failure = reply<TaskView>(2, `/api/v1/tasks/${first.taskId}`).data;
  assert.equal(failure.status, 'validation_failed');
  assert.equal(
    failure.validation!.items.find((item) => item.check?.name === 'normalize-smoke')!.passed,
    false,
  );
  const final = reply<ReportView>(11, `/api/v1/workflows/${recording.runId}/report`).data;
  assert.equal(final.status, 'completed');
  assert.equal(final.summary.succeededNodes, 4);
  assert.equal(final.summary.totalAttempts, 9);
  assert.equal(final.summary.total.inputTokens + final.summary.total.outputTokens, 0);
  assert.ok(final.summary.invalidatedAttempts > 0);
  const docs = workflow(11).nodes.find((node) => node.id === 'documentation')!;
  const doc = reply<TaskView>(11, `/api/v1/tasks/${docs.currentTask!.id}`).data;
  assert.equal(doc.skills[0].id, 'doc-style');
  assert.equal(doc.summary!.kind, 'extractive');
  assert.ok(doc.handoff!.sources[0].validationId);
  const oldReq = workflow(1).nodes[0].attempts[0];
  const artifact = reply<TaskView>(1, `/api/v1/tasks/${oldReq.taskId}`).data.artifacts[0];
  const changed =
    recording.frames[8].responses[`/api/v1/tasks/${oldReq.taskId}/artifacts/${artifact.id}`];
  assert.equal(changed.status, 409);
  assert.ok('error' in changed.body && changed.body.error.code === 'ARTIFACT_CHANGED');
  for (const frame of recording.frames)
    for (const [key, value] of Object.entries(frame.responses)) {
      assert.equal(value.body.apiVersion, 1);
      if (key.includes('/artifacts/') && value.status === 200) {
        const artifact = (value.body as ApiResponse<ArtifactContentView>).data;
        assert.equal(
          createHash('sha256').update(artifact.content).digest('hex'),
          artifact.recordedSha256,
        );
      }
    }
  const inspect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(
        ![
          'messages',
          'reasoning_content',
          'pendingCalls',
          'stdout',
          'stderr',
          'executionConfigHash',
        ].includes(key),
        key,
      );
      inspect(child);
    }
  };
  inspect(recording);
  assert.throws(() => parseRecording({ version: 99 }));
});

test('recorder runs the real workflow and configured checks in a new workspace, refusing existing user data', async (t) => {
  const parent = await fixture(t);
  const workspace = path.join(parent.workspace, 'showcase');
  const recorded = await recordShowcase(workspace);
  assert.equal(recorded.frames.length, 12);
  const report = recorded.frames.at(-1)!.responses[`/api/v1/workflows/${recorded.runId}/report`]
    .body as ApiResponse<ReportView>;
  assert.equal(report.data.status, 'completed');
  assert.equal(report.data.summary.succeededNodes, 4);
  assert.equal(JSON.stringify(recorded).includes(workspace), false);
  await assert.rejects(recordShowcase(workspace), { code: 'EEXIST' });
});

test('static transport supports filter-bound pagination and owner event cursors, preserving recorded errors with no network fallback', async () => {
  const transport = createDemoTransport(recording, 11);
  const get = (route: string) => transport('/api/v1/' + route);
  const first = await (await get('tasks?scope=all&limit=2')).json();
  assert.equal(first.data.items.length, 2);
  const second = await (
    await get('tasks?scope=all&limit=2&cursor=' + encodeURIComponent(first.data.nextCursor))
  ).json();
  assert.equal(new Set([...first.data.items, ...second.data.items].map((task) => task.id)).size, 4);
  assert.equal(
    (await get('tasks?scope=standalone&cursor=' + encodeURIComponent(first.data.nextCursor)))
      .status,
    400,
  );
  assert.equal((await (await get('tasks')).json()).data.items.length, 1);
  assert.equal((await (await get('workflows?status=failed')).json()).data.items.length, 0);
  const events = `events?scope=workflow&id=${recording.runId}`;
  const page = await (await get(events + '&limit=1')).json();
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.hasMore, true);
  const next = await (await get(events + '&after=' + page.data.nextAfter)).json();
  assert.ok(next.data.items.every((event: { seq: number }) => event.seq > page.data.nextAfter));
  assert.equal((await get(events + '&after=999999')).status, 409);
  for (const route of [
    'tasks?scope=other',
    'tasks?limit=101',
    'tasks?limit=2&limit=3',
    'tasks?path=.env',
  ])
    assert.equal((await get(route)).status, 400);
  assert.equal((await get('unknown')).status, 404);
  assert.equal((await transport('/api/v1/tasks', { method: 'POST' })).status, 405);
  assert.equal((await transport('https://example.invalid')).status, 400);
  const client = new ReadClient(createDemoTransport(recording, 0));
  await assert.rejects(
    client.get(
      `/api/v1/tasks/${workflow(11).nodes[0].currentTask!.id}`,
      new AbortController().signal,
    ),
    { code: 'NOT_RECORDED' },
  );
  assert.throws(() => createDemoTransport(recording, 100));
});

test('static host supports shared frame URLs and refuses live API or arbitrary query paths', async (t) => {
  const store = await fixture(t);
  const directory = path.join(store.workspace, 'web');
  await mkdir(directory);
  await writeFile(path.join(directory, 'index.html'), 'static');
  const origin = 'http://127.0.0.1:4311';
  const host = await createDemoHost(directory, origin);
  assert.equal((await host(new Request(origin + '/?frame=6'))).status, 200);
  for (const query of ['?path=.env', '?frame=../file', '?frame=1&frame=2', '?frame=2&path=any'])
    assert.equal((await host(new Request(origin + '/' + query))).status, 404);
  const api = await host(new Request(origin + '/api/v1/workspace'));
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error.code, 'NO_LIVE_API');
  assert.equal(
    (await host(new Request(origin + '/?frame=6', { headers: { origin: 'http://evil.invalid' } })))
      .status,
    403,
  );
});

test('Web replays and rewinds snapshots without network requests or stale event cursors', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Showcase } = await import('../../apps/web/src/demo/showcase.tsx');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `http://127.0.0.1:4311/?frame=0#/workflows/${recording.runId}`,
    pretendToBeVisual: true,
  });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'fetch',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  let network = 0;
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    navigator: { value: dom.window.navigator, configurable: true },
    HTMLElement: { value: dom.window.HTMLElement, configurable: true },
    fetch: {
      value: () => {
        network++;
        throw new Error('network forbidden');
      },
      configurable: true,
    },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  };
  await act(async () => root.render(createElement(Showcase, { recording })));
  await flush();
  await flush();
  assert.match(dom.window.document.body.textContent!, /固定脚本录制/);
  const select = () =>
    dom.window.document.querySelector('select[aria-label="回放阶段"]') as HTMLSelectElement;
  const jump = async (value: string) => {
    await act(async () => {
      select().value = value;
      select().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush();
    await flush();
  };
  await jump('2');
  assert.match(dom.window.document.querySelector('.heading-actions')!.textContent!, /已失败/);
  await jump('6');
  assert.match(dom.window.document.querySelector('.heading-actions')!.textContent!, /已完成/);
  await jump('0');
  assert.equal(dom.window.document.body.textContent!.includes('CURSOR_AHEAD'), false);
  const speed = dom.window.document.querySelector(
    'select[aria-label="回放速度"]',
  ) as HTMLSelectElement;
  await act(async () => {
    speed.value = '2000';
    speed.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    [...dom.window.document.querySelectorAll('button')]
      .find((button) => button.textContent === '播放')!
      .click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2150));
  });
  await flush();
  assert.equal(select().value, '1');
  await act(async () =>
    [...dom.window.document.querySelectorAll('button')]
      .find((button) => button.textContent === '暂停')!
      .click(),
  );
  assert.equal(network, 0);
});
