import type { CheckDefinition, CheckResult } from '../types.ts';

export interface CheckRunner {
  /** Validate the execution location without starting a command or causing its side effects. */
  prepare(name: string, spec: CheckDefinition, workspace: string): Promise<PreparedCheck>;
}

export interface PreparedCheck {
  run(signal: AbortSignal): Promise<CheckResult>;
}
