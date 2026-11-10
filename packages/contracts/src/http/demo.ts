import type { ApiError, ApiResponse } from './index.ts';

/** Only public API views, never internal checkpoints or provider conversations. */
export interface DemoReply { status: number; body: ApiResponse<unknown> | ApiError }
export interface DemoFrame {
  id: string;
  label: string;
  description: string;
  recordedAt: string;
  responses: Record<string, DemoReply>;
}
export interface DemoRecording {
  version: 1;
  provenance: 'scripted-runtime';
  name: string;
  description: string;
  runId: string;
  frames: DemoFrame[];
}
