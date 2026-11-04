import { currentAttempt } from '@taskweave/core';
import type { WorkflowRun } from '@taskweave/contracts';
import type { IO } from './task.ts';

export const HELP = `TaskWeave workflow v0.4.0-alpha.1

workflow create --file examples/workflows/delivery.json --workspace work
workflow run    --file examples/workflows/demo.json --workspace work --demo
workflow resume <run-id> --workspace work [--demo]
workflow show   <run-id> --workspace work [--json]
workflow report <run-id> --workspace work [--json]
workflow list   --workspace work [--json]
workflow events <run-id> --workspace work [--after N]
workflow accept <run-id> --node <id> --attempt <attempt-id> --note "验收依据"
workflow reject <run-id> --node <id> --attempt <attempt-id> --note "修改意见"
workflow answer <run-id> --node <id> --attempt <attempt-id> --answer "补充信息"
workflow rework <run-id> --node <id> --attempt <attempt-id> --note "上游变更"
workflow retry  <run-id> --node <id> --attempt <attempt-id> --note "重试原因"

create 只保存定义；run / resume 串行调度至等待、失败或完成。
report 只读已有状态与事件，无需模型密钥；默认终端摘要，--json 输出完整报告。
accept / answer 成功后自动调度下游，需要模型配置（演示需 --demo）。
rework / retry 标记过期，随后用 resume 执行新的 attempt。
--file 基于当前目录；--config 基于工作区（默认 .taskweave/config.json）。
--timeout 整次 CLI 操作时限，秒，默认 300、最大 3600。
--max-steps 每个节点累计模型调用上限，1 到 200。
Ctrl+C 保留检查点；强制退出的遗留锁先用 taskweave unlock 检查。`;
export function printWorkflow(run: WorkflowRun, io: IO, json: boolean): void {
  if (json) { io.out(JSON.stringify(run, null, 2)); return; }
  io.out(`${run.id}  ${run.status}  ${run.definition.name}`);
  for (const node of run.nodes) {
    const attempt = currentAttempt(node);
    io.out(`  ${node.id}: ${node.status}${attempt ? `  ${attempt.id}  task=${attempt.taskId}` : ''}`);
    if (attempt?.error) io.err(`  ${node.id}: ${attempt.error}`);
  }
  if (run.error) io.err(run.error);
  if (run.nodes.some(node => node.status === 'ready')) io.out('待执行节点可用 workflow resume 继续。');
}
