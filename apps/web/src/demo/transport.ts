import type {
  ApiResponse,
  DemoFrame,
  DemoRecording,
  DemoReply,
  EventPage,
  Page,
  TaskListItem,
  WorkflowListItem,
} from '@taskweave/contracts';
import type { Transport } from '../data/client.ts';

/** No fetch fallback: a missing recording is an explicit error, never a live request. */
export function createDemoTransport(recording: DemoRecording, frameIndex: number): Transport {
  if (
    recording.version !== 1 ||
    recording.provenance !== 'scripted-runtime' ||
    !recording.frames[frameIndex]
  )
    throw new Error('演示录制格式或阶段无效');
  const frame: DemoFrame = recording.frames[frameIndex];
  const error = (status: number, code: string, message: string) =>
    Response.json(
      { apiVersion: 1, observedAt: frame.recordedAt, error: { code, message } },
      { status },
    );
  const integer = (value: string | null, fallback: number, max: number) =>
    value === null
      ? fallback
      : /^(0|[1-9][0-9]*)$/.test(value) &&
          Number.isSafeInteger(Number(value)) &&
          Number(value) <= max
        ? Number(value)
        : -1;
  const respond = (reply: DemoReply) => Response.json(reply.body, { status: reply.status });
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    if (typeof input !== 'string' || !input.startsWith('/api/v1/'))
      return error(400, 'INVALID_ROUTE', '演示仅接受相对 API 路径');
    if ((init?.method ?? 'GET') !== 'GET') return error(405, 'METHOD_NOT_ALLOWED', '演示只读');
    const url = new URL(input, 'https://demo.invalid');
    const params = url.searchParams;
    const allowed =
      url.pathname === '/api/v1/tasks'
        ? ['scope', 'status', 'limit', 'cursor']
        : url.pathname === '/api/v1/workflows'
          ? ['status', 'limit', 'cursor']
          : url.pathname === '/api/v1/events'
            ? ['scope', 'id', 'after', 'limit']
            : [];
    if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1))
      return error(400, 'INVALID_ARGUMENTS', '未知或重复演示查询参数');
    if (url.pathname === '/api/v1/tasks' || url.pathname === '/api/v1/workflows') {
      const tasks = url.pathname.endsWith('/tasks');
      const statuses = tasks
        ? [
            'pending',
            'running',
            'waiting_input',
            'validating',
            'validation_failed',
            'waiting_acceptance',
            'completed',
            'failed',
            'cancelled',
            'budget_exceeded',
          ]
        : [
            'pending',
            'running',
            'waiting_input',
            'waiting_acceptance',
            'completed',
            'failed',
            'cancelled',
          ];
      if (params.has('status') && !statuses.includes(params.get('status')!))
        return error(400, 'INVALID_ARGUMENTS', '状态筛选值无效');
      const scope = params.get('scope') ?? 'standalone';
      if (tasks && scope !== 'all' && scope !== 'standalone')
        return error(400, 'INVALID_ARGUMENTS', '任务范围无效');
      const reply = frame.responses[url.pathname];
      if (!reply || reply.status !== 200) return error(404, 'NOT_RECORDED', '本阶段未录制列表');
      const body = structuredClone(reply.body) as ApiResponse<
        Page<TaskListItem | WorkflowListItem>
      >;
      const rows = body.data.items.filter(
        (item) =>
          (!params.get('status') || item.status === params.get('status')) &&
          (!tasks || scope === 'all' || !(item as TaskListItem).workflow),
      );
      const limit = integer(params.get('limit'), 20, 100);
      if (limit < 1) return error(400, 'INVALID_ARGUMENTS', '分页大小无效');
      const filter = JSON.stringify([
        frame.id,
        url.pathname,
        params.get('status'),
        tasks ? scope : 'all',
      ]);
      let offset = 0;
      if (params.has('cursor')) {
        try {
          const cursor = JSON.parse(decodeURIComponent(params.get('cursor')!));
          if (
            cursor.filter !== filter ||
            !Number.isSafeInteger(cursor.offset) ||
            cursor.offset < 0 ||
            cursor.offset > rows.length
          )
            throw new Error();
          offset = cursor.offset;
        } catch {
          return error(400, 'INVALID_CURSOR', '游标不属于当前演示阶段或筛选条件');
        }
      }
      body.data = {
        items: rows.slice(offset, offset + limit),
        nextCursor:
          offset + limit < rows.length
            ? encodeURIComponent(JSON.stringify({ filter, offset: offset + limit }))
            : null,
      };
      return Response.json(body);
    }
    if (url.pathname === '/api/v1/events') {
      const scope = params.get('scope');
      const id = params.get('id');
      if ((scope !== 'task' && scope !== 'workflow') || !id)
        return error(400, 'INVALID_ARGUMENTS', '事件归属无效');
      const reply = frame.responses[`/api/v1/events?scope=${scope}&id=${id}`];
      if (!reply) return error(404, 'NOT_RECORDED', '本阶段未录制该对象事件');
      const body = structuredClone(reply.body) as ApiResponse<EventPage>;
      const after = integer(params.get('after'), 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(params.get('limit'), 100, 200);
      if (after < 0 || limit < 1) return error(400, 'INVALID_ARGUMENTS', '事件游标或分页大小无效');
      if (after > body.data.snapshotSeq)
        return error(409, 'CURSOR_AHEAD', '游标超过当前录制阶段，请重新加载');
      const selected = body.data.items.filter((event) => event.seq > after);
      const items = selected.slice(0, limit);
      body.data = {
        ...body.data,
        items,
        hasMore: selected.length > limit,
        nextAfter: items.at(-1)?.seq ?? after,
      };
      return Response.json(body);
    }
    const reply = frame.responses[url.pathname];
    return reply ? respond(reply) : error(404, 'NOT_RECORDED', '该记录在本演示阶段不可用');
  };
}

/** Validate the bundled recording envelope; payload views originate from the read API. */
export function parseRecording(value: unknown): DemoRecording {
  if (!value || typeof value !== 'object') throw new Error('演示录制缺失');
  const recording = value as DemoRecording;
  if (
    recording.version !== 1 ||
    recording.provenance !== 'scripted-runtime' ||
    !/^wf_[a-f0-9]{24}$/.test(recording.runId) ||
    typeof recording.name !== 'string' ||
    !Array.isArray(recording.frames) ||
    !recording.frames.length ||
    recording.frames.length > 100
  )
    throw new Error('演示录制格式无效');
  const ids = new Set<string>();
  for (const frame of recording.frames) {
    if (
      !frame ||
      typeof frame.id !== 'string' ||
      ids.has(frame.id) ||
      typeof frame.label !== 'string' ||
      typeof frame.description !== 'string' ||
      !Number.isFinite(Date.parse(frame.recordedAt)) ||
      !frame.responses ||
      !frame.responses['/api/v1/workspace']
    )
      throw new Error('演示阶段格式无效');
    ids.add(frame.id);
    for (const [key, reply] of Object.entries(frame.responses)) {
      if (
        !key.startsWith('/api/v1/') ||
        !reply ||
        !Number.isSafeInteger(reply.status) ||
        reply.status < 200 ||
        reply.status > 599 ||
        !reply.body ||
        reply.body.apiVersion !== 1
      )
        throw new Error('演示响应格式无效');
    }
  }
  return recording;
}
