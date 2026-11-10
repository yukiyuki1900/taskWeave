import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLocalReadApi, createWebHandler } from '@taskweave/server';
import { fixture } from '../helpers.ts';

const origin = 'http://127.0.0.1:4310';
test('Web build is served same-origin without exposing workspace files or changing API responses', async (t) => {
  const store = await fixture(t);
  const directory = path.join(store.workspace, 'web');
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(directory, 'assets', 'index-a1.js'), 'console.log("build")');
  await writeFile(path.join(store.workspace, 'private.txt'), 'PRIVATE_WORKSPACE_CONTENT');
  const api = await createLocalReadApi(store.workspace, { origin });
  const handler = await createWebHandler(api, directory, origin);
  const get = (route: string, init?: RequestInit) => handler(new Request(origin + route, init));
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/html/);
  assert.match(response.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const script = await get('/assets/index-a1.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type')!, /javascript/);
  const apiResponse = await get('/api/v1/workspace');
  assert.equal((await apiResponse.json()).data.readOnly, true);
  for (const route of ['/api/no-such-route', '/api/v1/no-such-route']) {
    const result = await get(route);
    assert.equal(result.status, 404);
    assert.equal((await result.json()).error.code, 'NOT_FOUND');
  }
  for (const route of [
    '/private.txt',
    '/.taskweave/tasks',
    '/assets/../private.txt',
    '/%2e%2e%2fprivate.txt',
    '/assets/index-a1.js.map',
    '/workflows/foo',
    '/?file=private.txt',
  ]) {
    const result = await get(route);
    assert.equal(result.status, 404);
    assert.equal((await result.text()).includes('PRIVATE_'), false);
  }
  for (const method of ['POST', 'DELETE', 'HEAD', 'OPTIONS'])
    assert.equal((await get('/', { method })).status, 405);
  for (const route of ['/', '/assets/index-a1.js']) {
    assert.equal((await get(route, { headers: { origin: 'http://evil.invalid' } })).status, 403);
    assert.equal((await get(route, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  }
  assert.equal((await handler(new Request('http://evil.invalid/'))).status, 403);
  // In-memory build snapshot: later filesystem changes cannot inject a new script.
  await writeFile(path.join(directory, 'assets', 'index-a1.js'), 'CHANGED_BUILD');
  assert.equal(await (await get('/assets/index-a1.js')).text(), 'console.log("build")');
  assert.equal(
    await readFile(path.join(store.workspace, 'private.txt'), 'utf8'),
    'PRIVATE_WORKSPACE_CONTENT',
  );
});

test('Web hosting requires a complete bounded static build and refuses links or unapproved files', async (t) => {
  const store = await fixture(t);
  const directory = path.join(store.workspace, 'web');
  await mkdir(directory);
  const api = await createLocalReadApi(store.workspace, { origin });
  await assert.rejects(createWebHandler(api, directory, origin), /index.html/);
  await writeFile(path.join(directory, 'index.html'), 'web');
  await writeFile(path.join(store.workspace, 'outside.js'), 'secret');
  await symlink('../outside.js', path.join(directory, 'app.js'));
  await assert.rejects(createWebHandler(api, directory, origin), /非静态/);
  const { rm } = await import('node:fs/promises');
  await rm(path.join(directory, 'app.js'));
  await writeFile(path.join(directory, 'private.json'), '{"secret":true}');
  await assert.rejects(createWebHandler(api, directory, origin), /非静态/);
  await rm(path.join(directory, 'private.json'));
  await writeFile(path.join(directory, 'big.js'), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(createWebHandler(api, directory, origin), /超限/);
});
