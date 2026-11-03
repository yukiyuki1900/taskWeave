import type { RuntimeServices } from '@taskweave/core/ports';
import { Workspace } from './workspace/local/workspace.ts';
import { ProcessCheckRunner } from './checks/process/runner.ts';

/** Local execution shares the same core services as a future worker host. */
export const localServices: RuntimeServices = {
  workspace: root => new Workspace(root),
  checkRunner: new ProcessCheckRunner()
};
