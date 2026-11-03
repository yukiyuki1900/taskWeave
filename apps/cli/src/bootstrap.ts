import { CompatibleProvider, DemoProvider } from '@taskweave/adapters';
export { localServices, loadConfig, loadWorkflow, TaskStore } from '@taskweave/adapters';
import type { ModelProvider, TaskKind } from '@taskweave/core/types';

export function providerFor(kind: TaskKind, demo: boolean): ModelProvider {
  return demo ? new DemoProvider(kind) : new CompatibleProvider({
    baseUrl: process.env.TASKWEAVE_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.TASKWEAVE_MODEL || 'deepseek-flash',
    apiKey: process.env.TASKWEAVE_API_KEY || ''
  });
}
