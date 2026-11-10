import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '@taskweave/contracts';
import { useDataSource } from './source.tsx';

export interface QueryState<T> {
  response?: ApiResponse<T>;
  error?: Error;
  loading: boolean;
}
/** Sequential polling: abort on identity changes, pause hidden tabs, back off failures. */
export function useQuery<T>(path: string | null, poll = true): QueryState<T> & { refresh(): void } {
  const { client, mode } = useDataSource();
  const live = poll && mode === 'live';
  const [state, setState] = useState<QueryState<T> & { path: string | null }>({
    path,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const response = useRef<{ path: string; value: ApiResponse<T> } | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    let busy = false;
    const saved = response.current?.path === path ? response.current.value : undefined;
    setState({ path, response: saved, loading: !saved });
    const load = async () => {
      if (controller.signal.aborted || busy) return;
      clearTimeout(timer);
      if (document.hidden) return;
      busy = true;
      try {
        const next = await client.get<T>(path, controller.signal);
        if (controller.signal.aborted) return;
        response.current = { path, value: next };
        failures = 0;
        setState({ path, response: next, loading: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        failures++;
        setState((previous) => ({
          path,
          response: previous.path === path ? previous.response : undefined,
          error: error instanceof Error ? error : new Error('查询失败'),
          loading: false,
        }));
      } finally {
        busy = false;
        if (!controller.signal.aborted && live)
          timer = setTimeout(
            () => {
              void load();
            },
            Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)),
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
  }, [path, live, nonce, client]);
  return { ...(state.path === path ? state : { loading: true }), refresh };
}
