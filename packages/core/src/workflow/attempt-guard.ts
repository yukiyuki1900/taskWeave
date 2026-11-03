import type { StateStore } from '../ports/index.ts';
import { TaskWeaveError } from '../errors.ts';
import type { Task } from '../task/types.ts';

/** Check identity under the workspace lock immediately before effects or acceptance. */
export async function assertWorkflowTask(store: StateStore, task: Task, runningOnly = false): Promise<void> {
  if (!task.workflow) return;
  store.assertLocked();
  const run = await store.loadWorkflow(task.workflow.runId);
  const node = run.nodes.find(node => node.id === task.workflow!.nodeId);
  const attempt = node?.attempts.find(attempt => attempt.id === task.workflow!.attemptId);
  if (!node || !attempt || node.currentAttemptId !== attempt.id || attempt.taskId !== task.id || attempt.status === 'invalidated' || (runningOnly && node.status !== 'running')
    || attempt.sourceAttempts.some(source => {
      const upstream = run.nodes.find(node => node.id === source.nodeId);
      return upstream?.status !== 'succeeded' || upstream.currentAttemptId !== source.attemptId;
    })) throw new TaskWeaveError('STALE_ATTEMPT', '执行已过期，不能继续写入或验收');
}
