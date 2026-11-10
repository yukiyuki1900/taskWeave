import { PRESETS } from '@taskweave/core';
import type { Task } from '@taskweave/core/types';

export const HELP = `TaskWeave  v0.5.0-alpha.1

任务驱动的 Agent：需求、测试、文档与代码共享执行内核。

用法：
  taskweave run --kind requirements --prompt "设计一个团队待办应用" --workspace ./work
  taskweave run --demo --kind document --prompt "生成说明文档" --workspace ./demo
  taskweave resume <task-id> --workspace ./work [--answer "补充信息"]
  taskweave list --workspace ./work
  taskweave show <task-id> --workspace ./work
  taskweave summary <task-id> --workspace ./work [--json]
  taskweave skills list --workspace ./work
  taskweave skills show <skill-id> --workspace ./work
  taskweave events <task-id> --workspace ./work [--after 10]
  taskweave unlock --workspace ./work
  taskweave validate <task-id> --workspace ./work
  taskweave accept <task-id> --workspace ./work --note "已核查需求与产物"
  taskweave reject <task-id> --workspace ./work --note "请补充异常流程"
  taskweave eval --suite examples/evaluation/baseline.json --workspace .cache/evaluations
  taskweave workflow --help

选项：
  --kind         requirements | tests | document | code | general（默认 general）
  --prompt       任务目标
  --skill        显式选择已注册的本地 Skill（可重复，最多 3 个；仅 run）
  --workspace    工作目录（默认当前目录）
  --max-steps    累计模型调用上限（默认 24，最大 200，恢复时可增加）
  --timeout      本次执行时限，秒（默认 300，最大 3600）
  --answer       恢复等待输入的任务
  --config       工作区内的验证配置（默认 .taskweave/config.json）
  --note         人工验收或退回的依据，必填
  --suite        评测集，基于当前目录的相对路径
  --limit        只执行前 N 个评测用例
  --demo         使用固定脚本演示，不访问模型
  --json         向 stdout 输出 JSON；执行进度写到 stderr
  --help         显示帮助

模型配置：TASKWEAVE_API_KEY、TASKWEAVE_MODEL、TASKWEAVE_BASE_URL。
Ctrl+C 取消执行并保留检查点。默认生成后等待人工验收。子任务不会自动执行。`;

export interface IO { out: (line: string) => void; err: (line: string) => void }
export const defaultIO: IO = { out: line => process.stdout.write(line + '\n'), err: line => process.stderr.write(line + '\n') };

export function present(task: Task): Record<string, unknown> {
  return {
    id: task.id, kind: task.kind, title: task.title, status: task.status, parentId: task.parentId,
    workflow: task.workflow, handoff: task.handoff, summary: task.summary, skills: task.skills, contextBudget: task.contextBudget,
    goal: task.goal, acceptanceCriteria: task.acceptanceCriteria, workspace: task.workspace,
    steps: task.steps, maxSteps: task.maxSteps, provider: task.provider,
    artifacts: task.artifacts, childTaskIds: task.childTaskIds, usage: task.usage,
    awaitingInput: task.awaitingInput, answer: task.answer, error: task.error,
    validationPolicy: task.validationPolicy, validation: task.validation, validationHistory: task.validationHistory, approval: task.approval,
    createdAt: task.createdAt, updatedAt: task.updatedAt
  };
}

export function printTask(task: Task, io: IO, json: boolean): void {
  if (json) { io.out(JSON.stringify(present(task), null, 2)); return; }
  io.out(`${task.id}  ${task.status}  ${PRESETS[task.kind].label}\n${task.title}`);
  if (task.answer) io.out('\n' + task.answer);
  if (task.awaitingInput) io.out(`\n需要补充：${task.awaitingInput.question}\n使用 resume ${task.id} --answer "你的回答" 恢复。`);
  if (task.validation) io.out(`\n独立检查：${task.validation.status}\n` + task.validation.items.map(item => `  ${item.passed ? 'PASS' : 'FAIL'} ${item.name}: ${item.detail}`).join('\n'));
  if (task.status === 'waiting_acceptance') io.out(`\n等待人工验收：使用 accept ${task.id} --note "验收依据"；退回使用 reject。`);
  if (task.status === 'validation_failed') io.out(`\n验收未通过：使用 resume ${task.id} 修正，或 validate ${task.id} 重新检查。`);
  if (task.artifacts.length) io.out('\n产物：\n' + task.artifacts.map(file => `  ${file.path} (${file.bytes} bytes)`).join('\n'));
  if (task.childTaskIds.length) io.out('\n待查看子任务：\n' + task.childTaskIds.map(id => `  ${id}`).join('\n'));
  io.out(`\n模型调用：${task.steps}/${task.maxSteps}；tokens：${task.usage.input} input / ${task.usage.output} output`);
  if (task.error) io.err(task.error);
}

export function exitStatus(task: Task): number {
  return ['completed', 'waiting_input', 'waiting_acceptance'].includes(task.status) ? 0 : task.status === 'cancelled' ? 130 : 1;
}
