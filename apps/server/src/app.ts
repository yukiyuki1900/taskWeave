import type { ApiError, ApiResponse, WorkspaceView } from '@taskweave/contracts';
import type { ReadStateStore, WorkspacePort } from '@taskweave/core/ports';
import { ReadQueries } from './queries/read.ts';
import { paginate } from './queries/page.ts';
import { ApiFailure, badRequest } from './errors.ts';

const taskStatuses = ['pending', 'running', 'waiting_input', 'validating', 'validation_failed', 'waiting_acceptance', 'completed', 'failed', 'cancelled', 'budget_exceeded'];
const workflowStatuses = ['pending', 'running', 'waiting_input', 'waiting_acceptance', 'completed', 'failed', 'cancelled'];
export interface ApiOptions { name?: string; origin?: string; clock?: () => string }
function integer(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) badRequest('数值参数超出允许范围');
  return Number(value);
}
function parameters(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) badRequest('包含未知或重复查询参数');
}
function id(value: string, scope: 'task' | 'workflow'): string {
  if (!(scope === 'task' ? /^tw_[a-f0-9]{24}$/ : /^wf_[a-f0-9]{24}$/).test(value)) badRequest('任务或工作流 ID 无效');
  return value;
}
function failure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['ENOENT', 'NOT_FOUND'].includes(code)) return new ApiFailure(404, 'NOT_FOUND', '记录不存在或已不可读取');
  if (['PATH_DENIED', 'STATE_PATH_DENIED', 'ELOOP'].includes(code)) return new ApiFailure(403, 'PATH_DENIED', '禁止访问该文件或链接');
  if (code === 'BINARY_FILE') return new ApiFailure(415, 'UNSUPPORTED_ARTIFACT', '只支持 UTF-8 文本产物');
  if (['FILE_TOO_LARGE', 'COLLECTION_LIMIT'].includes(code)) return new ApiFailure(413, 'LIMIT_EXCEEDED', '数据超过本地查询读取上限');
  if (code === 'READ_CHANGED') return new ApiFailure(409, 'READ_CHANGED', '文件读取期间发生变化，请重新查询');
  return new ApiFailure(503, 'DATA_UNAVAILABLE', '记录暂不可读取或格式损坏，请稍后重新查询');
}
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };

/** Fetch-style handler is testable without opening a socket. It only receives read ports. */
export function createReadApi(store: ReadStateStore, workspace: Pick<WorkspacePort, 'read'>, options: ApiOptions = {}): (request: Request) => Promise<Response> {
  return async request => {
    const observedAt = options.clock?.() ?? new Date().toISOString();
    try {
      const url = new URL(request.url);
      if (options.origin && url.origin !== options.origin) throw new ApiFailure(403, 'ORIGIN_DENIED', '请求来源不匹配');
      const origin = request.headers.get('origin');
      if ((origin && origin !== (options.origin ?? url.origin)) || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiFailure(403, 'ORIGIN_DENIED', '只允许同源读取');
      if (request.method !== 'GET') throw new ApiFailure(405, 'METHOD_NOT_ALLOWED', '只读 API 仅支持 GET');
      const queries = new ReadQueries(store, workspace);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'v1' || url.pathname.endsWith('/')) throw new ApiFailure(404, 'NOT_FOUND', '接口不存在');
      let data: unknown;
      if (parts.length === 3 && parts[2] === 'workspace') {
        parameters(url, []);
        data = { name: options.name ?? 'TaskWeave', mode: 'local', readOnly: true, capabilities: ['workflows', 'tasks', 'reports', 'events', 'artifacts'] } satisfies WorkspaceView;
      } else if (parts.length === 3 && ['tasks', 'workflows'].includes(parts[2])) {
        const tasks = parts[2] === 'tasks';
        parameters(url, tasks ? ['status', 'limit', 'cursor', 'scope'] : ['status', 'limit', 'cursor']);
        const status = url.searchParams.get('status');
        if (status !== null && !(tasks ? taskStatuses : workflowStatuses).includes(status)) badRequest('状态筛选值无效');
        const limit = integer(url.searchParams.get('limit'), 20, 1, 100);
        const scope = tasks ? url.searchParams.get('scope') ?? 'standalone' : 'all';
        if (!['all', 'standalone'].includes(scope)) badRequest('任务 scope 仅支持 standalone 或 all');
        const filter = JSON.stringify([parts[2], status, scope]);
        if (tasks) {
          const rows = (await store.list()).filter(task => (!status || task.status === status) && (scope === 'all' || !task.workflow)).map(queries.taskItem);
          const page = paginate(rows, limit, url.searchParams.get('cursor'), filter);
          for (const task of page.items) queries.revision.tasks[task.id] = task.seq;
          data = page;
        } else {
          const rows = (await store.listWorkflows()).filter(run => !status || run.status === status).map(queries.workflowItem);
          const page = paginate(rows, limit, url.searchParams.get('cursor'), filter);
          for (const run of page.items) queries.revision.workflows[run.id] = run.seq;
          data = page;
        }
      } else if (parts[2] === 'workflows' && (parts.length === 4 || (parts.length === 5 && parts[4] === 'report'))) {
        parameters(url, []); const runId = id(parts[3], 'workflow');
        data = parts.length === 4 ? await queries.workflowDetail(runId) : await queries.report(runId, observedAt);
      } else if (parts[2] === 'tasks' && (parts.length === 4 || (parts.length === 6 && parts[4] === 'artifacts'))) {
        parameters(url, []); const taskId = id(parts[3], 'task');
        if (parts.length === 4) data = await queries.taskDetail(taskId);
        else { if (!/^art_[a-f0-9]{24}$/.test(parts[5])) badRequest('产物 ID 无效'); data = await queries.artifact(taskId, parts[5]); }
      } else if (parts.length === 3 && parts[2] === 'events') {
        parameters(url, ['scope', 'id', 'after', 'limit']);
        const scope = url.searchParams.get('scope');
        if (scope !== 'task' && scope !== 'workflow') badRequest('事件 scope 必须为 task 或 workflow');
        data = await queries.events(scope, id(url.searchParams.get('id') ?? '', scope), integer(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER), integer(url.searchParams.get('limit'), 100, 1, 200));
      } else throw new ApiFailure(404, 'NOT_FOUND', '接口不存在');
      const body: ApiResponse<unknown> = { apiVersion: 1, observedAt, revision: queries.revision, warnings: queries.warnings, data };
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new ApiFailure(413, 'LIMIT_EXCEEDED', '响应超过 4 MiB，请缩小查询范围');
      return new Response(encoded, { status: 200, headers });
    } catch (error) {
      const failed = failure(error);
      const body: ApiError = { apiVersion: 1, observedAt, error: { code: failed.code, message: failed.message, ...(failed.details ? { details: failed.details } : {}) } };
      return new Response(JSON.stringify(body), { status: failed.status, headers: { ...headers, ...(failed.status === 405 ? { allow: 'GET' } : {}) } });
    }
  };
}
