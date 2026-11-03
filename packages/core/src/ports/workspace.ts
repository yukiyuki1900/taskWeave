import type { Artifact } from '@taskweave/contracts';

export interface WorkspacePort {
  readonly root: string;
  walk(relative?: string, limit?: number): Promise<{ files: string[]; truncated: boolean }>;
  read(relative: string): Promise<{ content: string; hash: string }>;
  write(relative: string, content: string, expectedHash: string | null, signal: AbortSignal): Promise<{ artifact: Artifact; changed: boolean }>;
}
