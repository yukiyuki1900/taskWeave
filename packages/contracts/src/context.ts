import type { Artifact } from './artifact.ts';

export type SummaryEvidence =
  | { kind: 'goal'; sha256: string }
  | { kind: 'answer'; sha256: string }
  | { kind: 'artifact'; path: string; sha256: string }
  | { kind: 'tool'; callId: string; messageIndex: number; sha256: string };
export interface SummaryStatement { text: string; evidence: SummaryEvidence[] }
export interface TaskSummary {
  version: 1;
  id: string;
  kind: 'model' | 'extractive';
  status: 'valid' | 'stale';
  staleReason?: string;
  updatedAt: string;
  sourceMessageCount: number;
  sourceHash: string;
  goal: string;
  facts: SummaryStatement[];
  decisions: SummaryStatement[];
  constraints: SummaryStatement[];
  openQuestions: SummaryStatement[];
  outcome?: SummaryStatement;
  artifacts: Artifact[];
  validation?: { id: string; status: string; items: Array<{ name: string; passed: boolean }> };
}
export interface SkillBinding {
  id: string;
  description: string;
  version: string;
  path: string;
  sha256: string;
}
export interface ContextHandoff {
  version: 1;
  runId: string;
  nodeId: string;
  digest: string;
  sources: Array<{
    nodeId: string;
    attemptId: string;
    taskId: string;
    summary: TaskSummary;
    artifacts: Artifact[];
    validationId: string;
    approval?: { decision: 'accepted' | 'rejected'; time: string };
  }>;
}
