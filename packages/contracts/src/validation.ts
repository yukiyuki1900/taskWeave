export type ValidationRule =
  | { type: 'exists'; path: string }
  | { type: 'contains'; path: string; text: string }
  | { type: 'json_fields'; path: string; fields: string[] };
export interface ValidationPolicy {
  rules: ValidationRule[];
  checks: string[];
  requireApproval: boolean;
}
export interface CheckResult {
  name: string;
  status: 'passed' | 'failed' | 'timeout' | 'cancelled' | 'output_limit' | 'unknown';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  outputTruncated?: boolean;
}
export interface ValidationItem {
  name: string;
  passed: boolean;
  detail: string;
  check?: CheckResult;
}
export interface ValidationRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'passed' | 'failed';
  items: ValidationItem[];
}
