import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';
import { main, nodeHandler, createLocalReadApi } from '@taskweave/server';
import { fixture } from '../helpers.ts';

const origin = 'http://127.0.0.1:4310';
test('Node HTTP adapter serves and rejects requests through in-memory objects without binding a port', async t => {
  const store = await fixture(t); const api = await createLocalReadApi(store.workspace, { origin });
  const handler = nodeHandler(api, origin);
  async function request(host: string, method = 'GET', url = '/api/v1/workspace') {
    let status = 0; let headers: Record<string, string> = {}; let body = '';
    const incoming = { url, method, headers: { host }, resume() {} } as unknown as IncomingMessage;
    const outgoing = { writeHead(code: number, values: Record<string, string>) { status = code; headers = values; }, end(value: string) { body = value; } } as unknown as ServerResponse;
    await handler(incoming, outgoing); return { status, headers, body: JSON.parse(body) };
  }
  const good = await request('127.0.0.1:4310'); assert.equal(good.status, 200); assert.equal(good.body.data.readOnly, true);
  assert.equal((await request('evil.invalid')).status, 403);
  assert.equal((await request('127.0.0.1:4310', 'DELETE')).status, 405);
  assert.equal((await request('127.0.0.1:4310', 'GET', 'http://evil.invalid/api/v1/workspace')).status, 403);
});

test('Server executable documents its local read-only scope and validates arguments without starting a listener', async () => {
  const output: string[] = []; const errors: string[] = [];
  const io = { out: (message: string) => { output.push(message); }, err: (message: string) => { errors.push(message); } };
  assert.equal(await main(['--help'], io), 0); assert.match(output[0], /只读/);
  for (const args of [[], ['--workspace', 'unused', '--port', '0'], ['--workspace', 'unused', '--port', '65536'], ['--workspace', 'unused', '--port', 'NaN'], ['--workspace', 'unused', '--host', '0.0.0.0'], ['--workspace', 'unused', '--name', '']]) assert.equal(await main(args, io), 1);
  const { stdout } = await promisify(execFile)(process.execPath, ['apps/server/bin/taskweave-server.mjs', '--help']);
  assert.match(stdout, /127\.0\.0\.1/); assert.match(stdout, /api\/v1/);
});
