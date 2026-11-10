import { useEffect, useMemo, useState } from 'react';
import type { DemoRecording } from '@taskweave/contracts';
import { App } from '../app.tsx';
import { ReadClient } from '../data/client.ts';
import { DataSourceContext } from '../data/source.tsx';
import { createDemoTransport } from './transport.ts';

export function Showcase({ recording }: { recording: DemoRecording }) {
  const initial = Number(new URLSearchParams(window.location.search).get('frame') ?? 0);
  const [index, setIndex] = useState(
    Number.isSafeInteger(initial) && initial >= 0 && initial < recording.frames.length
      ? initial
      : 0,
  );
  const [playing, setPlaying] = useState(false);
  const [delay, setDelay] = useState(4000);
  const source = useMemo(
    () => ({
      mode: 'demo' as const,
      client: new ReadClient(createDemoTransport(recording, index)),
    }),
    [recording, index],
  );
  useEffect(() => {
    if (!playing) return;
    const advance = () => {
      if (!document.hidden)
        setIndex((previous) => Math.min(previous + 1, recording.frames.length - 1));
    };
    const timer = setInterval(advance, delay);
    return () => clearInterval(timer);
  }, [playing, delay, recording.frames.length]);
  useEffect(() => {
    if (index === recording.frames.length - 1) setPlaying(false);
  }, [index, recording.frames.length]);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('frame', String(index));
    window.history.replaceState(null, '', url);
  }, [index]);
  const frame = recording.frames[index];
  const move = (value: number) => {
    setPlaying(false);
    setIndex(value);
  };
  const controls = (
    <section className="replay-panel" aria-label="演示回放控制">
      <div className="replay-heading">
        <span className="tag">固定脚本录制 · 非真实模型效果</span>
        <strong>{recording.name}</strong>
      </div>
      <p>{frame.description}</p>
      <div className="replay-controls">
        <button disabled={index === 0} onClick={() => move(index - 1)}>
          上一步
        </button>
        <button
          onClick={() => {
            if (index === recording.frames.length - 1) setIndex(0);
            setPlaying((value) => !value);
          }}
        >
          {playing ? '暂停' : '播放'}
        </button>
        <button disabled={index === recording.frames.length - 1} onClick={() => move(index + 1)}>
          下一步
        </button>
        <label>
          阶段
          <select
            aria-label="回放阶段"
            value={index}
            onChange={(event) => move(Number(event.target.value))}
          >
            {recording.frames.map((item, i) => (
              <option key={item.id} value={i}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          速度
          <select
            aria-label="回放速度"
            value={delay}
            onChange={(event) => setDelay(Number(event.target.value))}
          >
            <option value={8000}>慢速 · 8 秒</option>
            <option value={4000}>标准 · 4 秒</option>
            <option value={2000}>快速 · 2 秒</option>
          </select>
        </label>
        <button
          onClick={() => {
            move(0);
            window.location.hash = `#/workflows/${recording.runId}`;
          }}
        >
          从头开始
        </button>
      </div>
      <p className="footnote">
        第 {index + 1}/{recording.frames.length} 阶段 · API 录制于 {frame.recordedAt} ·
        仅切换录制快照，不执行任务。Token 为 0，确认由脚本代行，调用计数是脚本 Provider
        回合。产物是录制时读取的内容，不查询当前磁盘。
      </p>
    </section>
  );
  // Remount per frame: rewind resets event cursors and invalidates every in-flight query.
  return (
    <DataSourceContext.Provider value={source}>
      <App key={frame.id} notice={controls} />
    </DataSourceContext.Provider>
  );
}
