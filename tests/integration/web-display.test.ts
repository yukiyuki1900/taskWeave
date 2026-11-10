import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { EventView, WorkflowView } from '@taskweave/contracts';
import { ReadClient, mergeEvents, QueryError } from '../../apps/web/src/data/client.ts';
import { href, parseRoute } from '../../apps/web/src/data/routes.ts';
import { graphLayers } from '../../apps/web/src/components/graph.tsx';
import { RichText } from '../../apps/web/src/components/common.tsx';

test('read client enforces relative GET, preserves API errors, and detects incompatible responses', async () => {
  let seen: RequestInit | undefined;
  const client = new ReadClient(async (_input, init) => {
    seen = init;
    return Response.json({
      apiVersion: 1,
      observedAt: 'now',
      revision: { tasks: {}, workflows: {} },
      warnings: [],
      data: { id: 'task' },
    });
  });
  assert.equal(
    (await client.get<{ id: string }>('/api/v1/tasks', new AbortController().signal)).data.id,
    'task',
  );
  assert.equal(seen?.method, 'GET');
  assert.equal(seen?.credentials, 'same-origin');
  assert.equal(seen?.cache, 'no-store');
  await assert.rejects(client.get('http://evil.invalid', new AbortController().signal), {
    code: 'INVALID_ROUTE',
  });
  const changed = new ReadClient(async () =>
    Response.json(
      {
        apiVersion: 1,
        error: {
          code: 'ARTIFACT_CHANGED',
          message: 'changed',
          details: { recordedSha256: 'old' },
        },
      },
      { status: 409 },
    ),
  );
  await assert.rejects(
    changed.get('/api/v1/tasks/id', new AbortController().signal),
    (error: unknown) =>
      error instanceof QueryError &&
      error.status === 409 &&
      error.details?.recordedSha256 === 'old',
  );
  for (const [response, code] of [
    [new Response('<html>web</html>'), 'INVALID_RESPONSE'],
    [Response.json({ apiVersion: 2 }), 'VERSION_MISMATCH'],
  ] as const)
    await assert.rejects(
      new ReadClient(async () => response).get('/api/v1/workspace', new AbortController().signal),
      { code },
    );
});

test('event deduplication includes scope, owner and seq; graph is topological; routes preserve historical selection', () => {
  const event = (seq: number): EventView => ({
    scope: 'task',
    id: 'tw_owner',
    seq,
    type: 'task.created',
    time: 'now',
    data: {},
  });
  const merged = mergeEvents([event(1), event(2)], {
    items: [event(2), event(3)],
    nextAfter: 3,
    hasMore: false,
    snapshotSeq: 3,
    complete: true,
  });
  assert.deepEqual(
    merged.map((item) => item.seq),
    [1, 2, 3],
  );
  assert.equal(
    mergeEvents([event(1)], {
      items: [{ ...event(1), scope: 'workflow' }],
      nextAfter: 1,
      hasMore: false,
      snapshotSeq: 1,
      complete: true,
    }).length,
    2,
  );
  const nodes = [
    { id: 'docs', dependsOn: ['code'] },
    { id: 'code', dependsOn: ['req'] },
    { id: 'req', dependsOn: [] },
  ] as WorkflowView['nodes'];
  assert.deepEqual(
    graphLayers(nodes).map((layer) => layer.map((node) => node.id)),
    [['req'], ['code'], ['docs']],
  );
  const route = {
    collection: 'workflows' as const,
    id: `wf_${'a'.repeat(24)}`,
    node: 'req',
    attempt: 'att_old',
    tab: 'context' as const,
  };
  assert.deepEqual(parseRoute(href(route)), route);
  assert.equal(parseRoute('#/tasks/wf_' + 'a'.repeat(24)), null);
  assert.equal(parseRoute('#/workflows?tab=invalid'), null);
});

test('Markdown never executes HTML, JavaScript links or loads external images', () => {
  const html = renderToStaticMarkup(
    createElement(RichText, {
      text: '# 标题\n<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n![remote](https://example.invalid/pixel)\n\n[官方](https://example.com)',
    }),
  );
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('Web navigates actual API snapshots and history, hides changed artifacts, and rejects stale late task responses', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createLocalReadApi } = await import('@taskweave/server');
  const { localServices } = await import('@taskweave/adapters');
  const { WorkflowEngine, currentAttempt } = await import('@taskweave/core');
  const { fixture, ScriptedProvider, turn, tool } = await import('../helpers.ts');
  const { writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const store = await fixture(t);
  let number = 0;
  const engine = new WorkflowEngine(localServices, store, () => {
    const file = `output-${++number}.md`;
    return new ScriptedProvider([
      () =>
        turn(
          tool('write_file', {
            path: file,
            content: '# 验证产物',
            expected_sha256: null,
          }),
        ),
      () => turn(),
    ]);
  });
  let run = await engine.run(
    (
      await engine.create({
        version: 1,
        name: 'Web 验证工作流',
        nodes: [{ id: 'req', kind: 'requirements', goal: '整理需求' }],
      })
    ).id,
  );
  const old = currentAttempt(run.nodes[0])!;
  await engine.review(run.id, 'req', old.id, 'accepted', '已核对');
  await engine.rework(run.id, 'req', old.id, '补充内容');
  run = await engine.run(run.id);
  const current = currentAttempt(run.nodes[0])!;
  const oldTask = await store.load(old.taskId);
  oldTask.answer = '历史回答标记';
  await store.save(oldTask);
  const currentTask = await store.load(current.taskId);
  currentTask.answer = '当前回答标记';
  await store.save(currentTask);
  const origin = 'http://127.0.0.1:4310';
  const api = await createLocalReadApi(store.workspace, { origin });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `${origin}/#/workflows/${run.id}`,
    pretendToBeVisual: true,
  });
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'IS_REACT_ACT_ENVIRONMENT',
    'fetch',
  ] as const;
  const previous = new Map(
    globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  let delayed: { response: Response; release(value: Response): void } | undefined;
  let holdOld = false;
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    navigator: { value: dom.window.navigator, configurable: true },
    HTMLElement: { value: dom.window.HTMLElement, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
    fetch: {
      configurable: true,
      value: async (input: string, init: RequestInit) => {
        const response = await api(new Request(origin + input, init));
        if (holdOld && input === `/api/v1/tasks/${old.taskId}`) {
          holdOld = false;
          return new Promise<Response>((release) => {
            delayed = { response, release };
          });
        }
        return response;
      },
    },
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globals) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
  };
  const navigate = async (hash: string) => {
    await act(async () => {
      dom.window.location.hash = hash;
    });
    await flush();
    await flush();
  };
  const text = () => dom.window.document.body.textContent!;
  const { App } = await import('../../apps/web/src/app.tsx');
  await act(async () => root.render(createElement(App)));
  await flush();
  await flush();
  assert.match(text(), /Web 验证工作流/);
  assert.match(text(), /当前回答标记/);
  assert.equal(text().includes('历史回答标记'), false);
  assert.ok(dom.window.document.querySelectorAll('.timeline li').length > 1);
  const metricsValue = () => dom.window.document.querySelectorAll('.metric strong')[1]?.textContent;
  const allTokens = metricsValue();
  await act(async () =>
    [...dom.window.document.querySelectorAll('button')]
      .find((button) => button.textContent === '当前尝试')!
      .click(),
  );
  assert.notEqual(metricsValue(), allTokens);
  await navigate('#/workflows');
  assert.match(dom.window.document.querySelector('tbody')!.textContent!, /Web 验证工作流/);
  await navigate(`#/workflows/${run.id}`);
  const base = `#/workflows/${run.id}?node=req&attempt=${old.id}`;
  await navigate(base);
  assert.match(text(), /历史回答标记/);
  assert.match(text(), /历史 attempt/);
  await navigate(base + '&tab=artifacts');
  const artifactButton = [...dom.window.document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('output-1.md'),
  )!;
  await act(async () => artifactButton.click());
  await flush();
  assert.match(text(), /验证产物/);
  await writeFile(path.join(store.workspace, 'output-1.md'), 'CHANGED_PRIVATE_CONTENT');
  // Recheck the already visible preview through the production polling path.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2150));
  });
  await flush();
  assert.match(text(), /产物已变化/);
  assert.equal(text().includes('CHANGED_PRIVATE_CONTENT'), false);
  assert.equal(text().includes('验证产物'), false);
  await navigate(`#/tasks/${current.taskId}`);
  await flush();
  holdOld = true;
  await navigate(`#/tasks/${old.taskId}`);
  assert.ok(delayed);
  await navigate(`#/tasks/${current.taskId}`);
  await flush();
  await act(async () => {
    delayed!.release(delayed!.response);
  });
  await flush();
  assert.match(text(), /当前回答标记/);
  assert.equal(text().includes('历史回答标记'), false);
});
