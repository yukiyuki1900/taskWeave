import { useEffect, useRef, useState } from 'react';
import type { ApiResponse, EventPage, EventView } from '@taskweave/contracts';
import { mergeEvents, QueryError } from '../data/client.ts';
import { useDataSource } from '../data/source.tsx';
import { Empty, Notice, time } from './common.tsx';

export function Events({ scope, id }: { scope: 'task' | 'workflow'; id: string }) {
  // Remount per owner so cursors and outstanding requests cannot cross scopes.
  return <OwnerEvents key={`${scope}:${id}`} scope={scope} id={id} />;
}
function OwnerEvents({ scope, id }: { scope: 'task' | 'workflow'; id: string }) {
  const { client, mode } = useDataSource();
  const [items, setItems] = useState<EventView[]>([]);
  const [error, setError] = useState<string>();
  const [incomplete, setIncomplete] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [observed, setObserved] = useState('');
  const [revision, setRevision] = useState(0);
  const [nonce, setNonce] = useState(0);
  const after = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    let failures = 0;
    const load = async () => {
      if (controller.signal.aborted || busy || document.hidden) return;
      clearTimeout(timer);
      busy = true;
      let more = false;
      try {
        const response: ApiResponse<EventPage> = await client.get(
          `/api/v1/events?scope=${scope}&id=${id}&after=${after.current}&limit=200`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const page = response.data;
        if (page.hasMore && page.nextAfter <= after.current)
          throw new Error('事件游标未推进，请重新加载时间线');
        setItems((previous) => mergeEvents(previous, page));
        after.current = page.nextAfter;
        if (!page.complete) setIncomplete(true);
        setWarnings((previous) => [...new Set([...previous, ...response.warnings])].slice(-20));
        setObserved(response.observedAt);
        setRevision(page.snapshotSeq);
        setError(undefined);
        failures = 0;
        more = page.hasMore;
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof QueryError && failure.code === 'CURSOR_AHEAD') {
          after.current = 0;
          setItems([]);
          setIncomplete(true);
        }
        failures++;
        setError(failure instanceof Error ? failure.message : '时间线读取失败');
      } finally {
        busy = false;
        if (!controller.signal.aborted && (mode === 'live' || more))
          timer = setTimeout(
            () => {
              void load();
            },
            more ? 100 : Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)),
          );
      }
    };
    const visible = () => {
      if (!document.hidden) void load();
      else clearTimeout(timer);
    };
    document.addEventListener('visibilitychange', visible);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [scope, id, nonce, client, mode]);
  return (
    <div>
      <div className="toolbar">
        <p className="footnote">
          {scope === 'task' ? '任务' : '工作流'}序号 {revision} · 观察于 {time(observed)} ·
          最多保留最近 1,000 条
        </p>
        <button
          onClick={() => {
            after.current = 0;
            setItems([]);
            setWarnings([]);
            setIncomplete(false);
            setNonce((value) => value + 1);
          }}
        >
          重新加载
        </button>
      </div>
      {error && <Notice>时间线更新失败：{error}。正在重试。</Notice>}
      {(incomplete || warnings.length > 0) && (
        <Notice>
          时间线存在缺失或重置，不应据此推断执行成功。
          {warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
        </Notice>
      )}
      {!items.length && <Empty>暂无可展示事件。</Empty>}
      <ol className="timeline">
        {items.map((event) => (
          <li key={`${event.scope}:${event.id}:${event.seq}`}>
            <span className="event-seq">{event.seq}</span>
            <div>
              <strong>{event.type}</strong>
              <small>{time(event.time)}</small>
              {Object.entries(event.data).map(([key, value]) => (
                <code key={key}>
                  {key}={String(value)}
                </code>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
