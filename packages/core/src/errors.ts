export class TaskWeaveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TaskWeaveError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
