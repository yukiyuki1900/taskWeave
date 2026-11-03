import { Workspace } from '../../workspace/local/workspace.ts';
import { parseWorkflow, TaskWeaveError } from '@taskweave/core';
import type { WorkflowDefinition } from '@taskweave/contracts';

export async function loadWorkflow(file: string): Promise<WorkflowDefinition> {
  const input = await new Workspace(process.cwd()).read(file);
  try { return parseWorkflow(JSON.parse(input.content)); }
  catch (error) { if (error instanceof TaskWeaveError) throw error; throw new TaskWeaveError('INVALID_WORKFLOW', '工作流定义无效：检查节点、依赖及资源上限，参考 docs/workflows.md'); }
}
