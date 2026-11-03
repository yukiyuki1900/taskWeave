export type { StateStore } from './state-store.ts';
export type { WorkspacePort } from './workspace.ts';
export type { CheckRunner, PreparedCheck } from './check-runner.ts';
export type { ModelProvider } from './model-provider.ts';
import type { WorkspacePort } from './workspace.ts';
import type { CheckRunner } from './check-runner.ts';

export interface RuntimeServices {
  workspace(root: string): WorkspacePort;
  checkRunner: CheckRunner;
}
