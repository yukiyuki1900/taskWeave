import { useState } from 'react';
import type { ReportView } from '@taskweave/contracts';
import { duration, Notice, number, Panel } from './common.tsx';

export function Metrics({ report }: { report: ReportView }) {
  const [mode, setMode] = useState<'total' | 'current'>('total');
  const summary = report.summary;
  const cost = summary[mode];
  const timing = summary.timing;
  const cards = [
    [
      '节点成功',
      `${summary.succeededNodes} / ${summary.totalNodes}`,
      summary.totalNodes
        ? `本次运行节点通过率 ${((100 * summary.succeededNodes) / summary.totalNodes).toFixed(0)}%`
        : '无节点',
    ],
    [
      'Token 用量',
      number(cost.inputTokens + cost.outputTokens),
      `输入 ${number(cost.inputTokens)} · 输出 ${number(cost.outputTokens)}`,
    ],
    ['执行耗时', duration(timing.executionMs), `总历时 ${duration(timing.elapsedMs)}`],
    [
      '人工介入',
      `${summary.human.actions.total} 次`,
      `等待 ${duration(timing.humanWaitMs)} · 请求 ${summary.human.requests.total} 次`,
    ],
  ];
  return (
    <Panel
      title="运行指标"
      aside={
        <div className="segmented" aria-label="成本统计范围">
          <button aria-pressed={mode === 'total'} onClick={() => setMode('total')}>
            全部尝试
          </button>
          <button aria-pressed={mode === 'current'} onClick={() => setMode('current')}>
            当前尝试
          </button>
        </div>
      }
    >
      {(!summary.dataComplete || !timing.complete) && (
        <Notice>报告数据不完整，以下数值仅反映已记录数据。</Notice>
      )}
      <div className="metrics">
        {cards.map(([label, value, detail]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </div>
        ))}
      </div>
      <p className="footnote">
        成本范围：
        {mode === 'total' ? '含过期和重试的全部 attempt' : '各节点当前 attempt'} · 模型{' '}
        {number(cost.modelCalls)} 次 · 工具 {number(cost.toolCalls)} 次 / 失败{' '}
        {number(cost.toolFailures)} 次 · 全运行人工操作与耗时不随成本范围切换
      </p>
      <p className="footnote">
        尝试 {summary.totalAttempts} 次（过期 {summary.invalidatedAttempts}） · 未归属时间{' '}
        {duration(timing.unattributedMs)} · 该通过率不代表跨运行的 Agent 成功率
      </p>
    </Panel>
  );
}
