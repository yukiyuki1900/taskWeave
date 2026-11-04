import { parseValidationPolicy } from '../config/index.ts';
import { sha256 } from '../hash.ts';
import { isTaskKind, TaskWeaveError } from '../types.ts';
import type { WorkflowDefinition, WorkflowRef } from '@taskweave/contracts';

const fail = (): never => { throw new TaskWeaveError('INVALID_WORKFLOW', '工作流定义无效：检查节点、依赖及资源上限，参考 docs/workflows.md'); };
function object(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !allowed.includes(key))) return fail();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail();
  return value.trim();
}
export function parseWorkflow(raw: unknown): WorkflowDefinition {
  const value = object(raw, ['version', 'name', 'nodes']);
  if (value.version !== 1 || !Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 30) return fail();
  const name = text(value.name, 160);
  const seen = new Set<string>();
  const nodes = value.nodes.map(rawNode => {
    const node = object(rawNode, ['id', 'title', 'kind', 'goal', 'dependsOn', 'acceptanceCriteria', 'validationPolicy', 'maxSteps', 'skills']);
    const id = text(node.id, 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) || seen.has(id) || !isTaskKind(node.kind)) return fail();
    seen.add(id);
    const dependsOn = node.dependsOn ?? [];
    const criteria = node.acceptanceCriteria ?? [];
    const maxSteps = node.maxSteps ?? 24;
    if (!Array.isArray(dependsOn) || dependsOn.length > 30 || dependsOn.some(item => typeof item !== 'string') || new Set(dependsOn).size !== dependsOn.length
      || !Array.isArray(criteria) || criteria.length > 12 || !Number.isSafeInteger(maxSteps) || Number(maxSteps) < 1 || Number(maxSteps) > 200) return fail();
    if (node.skills !== undefined && (!Array.isArray(node.skills) || node.skills.length > 3 || new Set(node.skills).size !== node.skills.length || node.skills.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)))) return fail();
    return { ...(node.skills === undefined ? {} : { skills: node.skills as string[] }), id, title: text(node.title ?? id, 160), kind: node.kind, goal: text(node.goal, 8_000), dependsOn: dependsOn as string[], acceptanceCriteria: criteria.map(item => text(item, 500)), maxSteps: Number(maxSteps), ...(node.validationPolicy === undefined ? {} : { validationPolicy: parseValidationPolicy(node.validationPolicy) }) };
  });
  if (nodes.some(node => node.dependsOn.some(id => id === node.id || !seen.has(id)))) return fail();
  const ordered = new Set<string>();
  while (ordered.size < nodes.length) {
    const ready = nodes.filter(node => !ordered.has(node.id) && node.dependsOn.every(id => ordered.has(id)));
    if (!ready.length) return fail();
    ready.forEach(node => ordered.add(node.id));
  }
  return { version: 1, name, nodes };
}

export function workflowTaskId(ref: WorkflowRef): string {
  return `tw_${sha256(`${ref.runId}:${ref.nodeId}:${ref.attemptId}`).slice(0, 24)}`;
}
