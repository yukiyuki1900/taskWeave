import type { WorkflowReport } from '@taskweave/contracts';
import type { IO } from './task.ts';

export function printWorkflowReport(report: WorkflowReport, io: IO, json: boolean): void {
  if (json) { io.out(JSON.stringify(report, null, 2)); return; }
  const { summary } = report;
  io.out(`${report.runId}  ${report.status}  ${report.name}`);
  if (report.error) io.out(`工作流错误：${report.error}`);
  io.out(`节点通过：${summary.succeededNodes}/${summary.totalNodes}；尝试：${summary.totalAttempts}（已失效 ${summary.invalidatedAttempts}）`);
  const time = summary.timing;
  io.out(`耗时：总计 ${time.elapsedMs} ms；已记录执行 ${time.executionMs} ms；人工等待 ${time.humanWaitMs} ms；其他/未观测 ${time.unattributedMs} ms`);
  io.out(`数据完整：${summary.dataComplete ? '是' : '否'}；时间记录完整：${time.complete ? '是' : '否'}`);
  for (const [label, cost] of [['当前尝试', summary.current], ['全部尝试', summary.total]] as const) {
    io.out(`${label}：tokens ${cost.inputTokens} input / ${cost.outputTokens} output；模型轮次 ${cost.modelCalls}；工具执行 ${cost.toolCalls}，失败 ${cost.toolFailures}`);
  }
  const { requests, actions } = summary.human;
  io.out(`人工请求：${requests.total}（输入 ${requests.input}，验收 ${requests.acceptance}）`);
  io.out(`人工操作：${actions.total}（回答 ${actions.answers}，接受 ${actions.acceptances}，退回 ${actions.rejections}，重试 ${actions.retries}，返工 ${actions.reworks}）`);
  for (const node of report.nodes) {
    io.out(`  ${node.id}: ${node.status}`);
    for (const attempt of node.attempts) {
      io.out(`    ${attempt.id} ${attempt.current ? '[current]' : '[history]'} ${attempt.status} task=${attempt.taskId} tokens=${attempt.cost.inputTokens}/${attempt.cost.outputTokens} execution=${attempt.timing.executionMs}ms`);
      if (attempt.error) io.out(`      ${attempt.error}`);
    }
  }
  io.out('Token 为服务端已返回用量；本报告不计算跨运行成功率。');
  for (const warning of report.warnings) io.err(`报告提示：${warning}`);
}
