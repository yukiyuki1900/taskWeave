import type { TaskKind, ValidationPolicy } from '@taskweave/contracts';

export interface CheckDefinition {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface RuntimeConfig {
  version: 1;
  checks: Record<string, CheckDefinition>;
  validation: Partial<Record<TaskKind, ValidationPolicy>>;
}
