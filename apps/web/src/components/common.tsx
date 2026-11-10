import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import type { ApiResponse } from '@taskweave/contracts';
import type { QueryState } from '../data/use-query.ts';

const labels: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  waiting_input: '等待输入',
  waiting_acceptance: '等待验收',
  validating: '验证中',
  validation_failed: '验证未通过',
  completed: '已完成',
  succeeded: '已成功',
  failed: '已失败',
  cancelled: '已取消',
  budget_exceeded: '预算耗尽',
  blocked: '依赖阻塞',
  ready: '就绪',
  invalidated: '已过期',
  passed: '已通过',
  accepted: '已接受',
  rejected: '已退回',
};
export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge tone-${status}`}>
      <i />
      {labels[status] ?? status}
    </span>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice" role="status">
      {children}
    </div>
  );
}
export function Warnings({ response }: { response?: Pick<ApiResponse<unknown>, 'warnings'> }) {
  return response?.warnings.length ? (
    <Notice>
      <strong>数据提示</strong>
      <ul>
        {response.warnings.map((message, i) => (
          <li key={i}>{message}</li>
        ))}
      </ul>
    </Notice>
  ) : null;
}
export function QueryFeedback({ query }: { query: QueryState<unknown> & { refresh(): void } }) {
  return (
    <>
      {query.loading && <Empty>正在读取运行记录…</Empty>}
      {query.error && (
        <div className="notice error" role="alert">
          <strong>{query.response ? '更新失败，以下保留上次数据。' : '读取失败。'}</strong>{' '}
          {query.error.message} <button onClick={query.refresh}>重试</button>
        </div>
      )}
      <Warnings response={query.response} />
    </>
  );
}
export const number = (value: number) => value.toLocaleString('zh-CN');
export const time = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { hour12: false })
    : '—';
export function duration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)} 秒`
    : `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(1)} 秒`;
}
export function safeLink(value: string) {
  return /^(https?:\/\/|#[^/])/.test(value) ? value : '';
}
export function RichText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        urlTransform={safeLink}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children} ↗
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span className="muted">[图片：{alt ?? '不加载远程图片'}]</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
export function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
export function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="meta">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
