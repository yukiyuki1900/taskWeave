import type { TaskKind, TaskStatus } from '../task.ts';
import type { WorkflowAttempt, WorkflowNodeStatus, WorkflowStatus } from '../workflow.ts';
import type { WorkflowCost, WorkflowTiming, WorkflowReport } from '../workflow-report.ts';

/** Browser-facing protocol. Internal checkpoints and raw event data are never API responses. */
export interface ApiRevision { workflows: Record<string, number>; tasks: Record<string, number> }
export interface ApiResponse<T> { apiVersion: 1; observedAt: string; revision: ApiRevision; warnings: string[]; data: T }
export interface ApiError { apiVersion: 1; observedAt: string; error: { code: string; message: string; details?: Record<string, string | number> } }
export interface Page<T> { items: T[]; nextCursor: string | null }
export type ProviderMode = 'demo' | 'model' | 'unknown';
export interface WorkspaceView { name: string; mode: 'local'; readOnly: true; capabilities: Array<'workflows' | 'tasks' | 'reports' | 'events' | 'artifacts'> }
export interface ArtifactView { id: string; path: string; recordedSha256: string; bytes: number }
export interface ArtifactContentView extends ArtifactView { currentSha256: string; content: string; format: 'markdown' | 'json' | 'text'; historicalContent: false }
export interface EvidenceView { kind: 'goal' | 'answer' | 'artifact' | 'tool'; sha256: string; path?: string; callId?: string }
export interface StatementView { text: string; evidence: EvidenceView[] }
export interface SummaryView {
  id: string; kind: 'model' | 'extractive'; status: 'valid' | 'stale'; updatedAt: string; evidenceCurrent: boolean;
  facts: StatementView[]; decisions: StatementView[]; constraints: StatementView[]; openQuestions: StatementView[]; outcome?: StatementView;
}
export interface SkillView { id: string; description: string; version: string; path: string; sha256: string }
export interface ValidationView {
  id: string; status: 'running' | 'passed' | 'failed'; startedAt: string; finishedAt?: string;
  items: Array<{ name: string; passed: boolean; detail: string; check?: { name: string; status: string; exitCode: number | null; durationMs: number } }>;
}
export interface TaskListItem {
  id: string; title: string; kind: TaskKind; status: TaskStatus; createdAt: string; updatedAt: string; seq: number;
  parentId?: string; workflow?: { runId: string; nodeId: string; attemptId: string };
  providerMode: ProviderMode; steps: number; maxSteps: number; usage: { input: number; output: number }; artifactCount: number;
}
export interface TaskView extends TaskListItem {
  goal: string; acceptanceCriteria: string[]; answer?: string; answerTruncated: boolean; error?: string; question?: string;
  currentAttempt: boolean | null; artifacts: ArtifactView[]; childTaskIds: string[];
  validation: ValidationView | null; approval: { decision: 'accepted' | 'rejected'; note: string; time: string; validationId: string } | null;
  summary: SummaryView | null; skills: SkillView[];
  handoff: { runId: string; nodeId: string; digest: string; sources: Array<{
    nodeId: string; attemptId: string; taskId: string; validationId: string;
    summary: Omit<SummaryView, 'evidenceCurrent'>; artifacts: ArtifactView[];
    approval?: { decision: 'accepted' | 'rejected'; time: string };
  }> } | null;
}
export interface WorkflowListItem {
  id: string; name: string; status: WorkflowStatus; createdAt: string; updatedAt: string; seq: number; succeededNodes: number; totalNodes: number;
}
export interface WorkflowView extends WorkflowListItem {
  error?: string;
  nodes: Array<{
    id: string; title: string; kind: TaskKind; goal: string; dependsOn: string[]; status: WorkflowNodeStatus; currentAttemptId?: string;
    currentTask?: { id: string; status: TaskStatus; seq: number };
    attempts: Array<{
      id: string; number: number; taskId: string; status: WorkflowAttempt['status']; startedAt: string; finishedAt?: string; invalidatedAt?: string;
      error?: string; reason?: string; sourceAttempts: Array<{ nodeId: string; attemptId: string }>; artifacts: ArtifactView[];
    }>;
  }>;
}
export interface ReportView {
  version: 1; runId: string; name: string; status: WorkflowStatus; error?: string;
  createdAt: string; generatedAt: string; observedUntil: string;
  summary: WorkflowReport['summary']; warnings: string[];
  nodes: Array<{ id: string; status: WorkflowNodeStatus; attempts: Array<{
    id: string; taskId: string; current: boolean; status: WorkflowAttempt['status']; taskStatus?: TaskStatus; providerMode: ProviderMode;
    startedAt: string; finishedAt?: string; invalidatedAt?: string; error?: string; dataComplete: boolean; cost: WorkflowCost; timing: WorkflowTiming;
  }> }>;
}
export interface EventView {
  scope: 'task' | 'workflow'; id: string; seq: number; time: string; type: string;
  data: { nodeId?: string; attemptId?: string; taskId?: string; name?: string; callId?: string; validationId?: string; code?: string; decision?: string; kind?: string; step?: number; replayed?: boolean };
}
export interface EventPage { items: EventView[]; nextAfter: number; hasMore: boolean; snapshotSeq: number; complete: boolean }
