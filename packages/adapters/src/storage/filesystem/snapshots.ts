import { isTaskKind, parseWorkflow, TaskWeaveError } from '@taskweave/core';
import type { Task, WorkflowRun } from '@taskweave/core/types';

export function decodeTask(raw: string, id: string, workspace: string): Task {
  const value = JSON.parse(raw) as Task;
  if (value.version !== 1 || value.id !== id || value.workspace !== workspace || !isTaskKind(value.kind)
    || !Array.isArray(value.messages) || !Array.isArray(value.pendingCalls) || !Number.isSafeInteger(value.steps)) {
    throw new TaskWeaveError('CORRUPT_TASK', '任务快照无效或属于其他工作区');
  }
  return value;
}

export function decodeWorkflow(raw: string, id: string, workspace: string): WorkflowRun {
  const run = JSON.parse(raw) as WorkflowRun;
  if (run.version !== 1 || run.id !== id || run.workspace !== workspace || !Array.isArray(run.nodes) || !Number.isSafeInteger(run.seq)) throw new TaskWeaveError('CORRUPT_WORKFLOW', '工作流快照无效或属于其他工作区');
  const definition = parseWorkflow(run.definition);
  if (run.nodes.length !== definition.nodes.length || run.nodes.some((node, index) => node.id !== definition.nodes[index].id || !Array.isArray(node.attempts))) throw new TaskWeaveError('CORRUPT_WORKFLOW', '工作流节点快照无效');
  return run;
}
