import path from 'node:path';
import { recordSummary } from '../agent/summary.ts';
import { skillContext } from '../skills/index.ts';
import { assertHandoff } from '../workflow/handoff.ts';
import type { WorkspacePort } from '../ports/index.ts';
import { assertWorkflowTask } from '../workflow/attempt-guard.ts';
import { createTask } from '../task/create.ts';
import type { StateStore, RuntimeServices } from '../ports/index.ts';
import { configHash, DEFAULT_VALIDATION, parseConfig } from '../config/index.ts';
import { runChecks } from '../validation/checks.ts';
import { errorMessage, isTaskKind, TaskWeaveError } from '../types.ts';
import type { RuntimeConfig, Task, ToolDefinition, ToolResult } from '../types.ts';

const text = { type: 'string' };
const schema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });
const definition = (name: string, description: string, parameters: Record<string, unknown>): ToolDefinition => ({ type: 'function', function: { name, description, parameters } });

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  definition('record_summary', '记录可追溯的任务摘要。在上下文变长前提炼事实、决策、约束和未决问题；每条必须引用 goal，或当前任务产物 artifact(path,sha256)，或此前轮次的工具结果 tool(call_id)。引用只证明来源，不代表结论已验收。', schema(
    Object.fromEntries(['facts', 'decisions', 'constraints', 'open_questions'].map(key => [key, {
      type: 'array', maxItems: 8,
      items: schema({
        text: { type: 'string', maxLength: 600 },
        evidence: { type: 'array', minItems: 1, maxItems: 5, items: schema({
          kind: { type: 'string', enum: ['goal', 'artifact', 'tool'] }, path: text, sha256: text, call_id: text
        }, ['kind']) }
      }, ['text', 'evidence'])
    }])), ['facts', 'decisions', 'constraints', 'open_questions'])),
  definition('run_checks', '运行用户预先配置的验证命令。只能传命令名称，不能传 Shell、参数或环境变量。失败时根据真实输出修正。', schema({ checks: { type: 'array', minItems: 1, maxItems: 30, items: text } }, ['checks'])),
  definition('list_files', '列出工作区内普通文件（跳过隐藏文件、依赖和符号链接）。返回 truncated 表示结果被截断。', schema({ path: text, limit: { type: 'integer', minimum: 1, maximum: 500 } })),
  definition('read_file', '按行读取 UTF-8 文件，同时返回完整文件 sha256。更新文件前先读取此 hash。', schema({ path: text, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, ['path'])),
  definition('search_files', '在工作区文本文件中进行不区分大小写的字面量搜索。返回路径、行号和片段，有扫描上限。', schema({ query: text, path: text, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query'])),
  definition('write_file', '原子创建或更新 UTF-8 文件。创建时 expected_sha256=null；更新时必须传 read_file 得到的 sha256。冲突时应重读。', schema({ path: text, content: text, expected_sha256: { type: ['string', 'null'] } }, ['path', 'content', 'expected_sha256'])),
  definition('create_task', '创建有类型、目标和验收标准的待执行子任务；不会自动执行。', schema({
    title: text, kind: { type: 'string', enum: ['requirements', 'tests', 'document', 'code', 'general'] }, goal: text,
    acceptance_criteria: { type: 'array', minItems: 1, maxItems: 12, items: text }
  }, ['title', 'kind', 'goal', 'acceptance_criteria'])),
  definition('ask_user', '缺少关键输入时暂停任务并向用户提问，用户通过 resume --answer 恢复。', schema({ question: text }, ['question']))
];

export function argumentObject(raw: string): Record<string, unknown> {
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new TaskWeaveError('INVALID_ARGUMENTS', '工具参数必须是有效 JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TaskWeaveError('INVALID_ARGUMENTS', '工具参数必须是对象');
  return result as Record<string, unknown>;
}

function string(args: Record<string, unknown>, key: string, max = 20_000): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TaskWeaveError('INVALID_ARGUMENTS', `${key} 必须为非空字符串，长度不超过 ${max}`);
  return value;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TaskWeaveError('INVALID_ARGUMENTS', `整数参数必须在 ${min} 到 ${max} 之间`);
  return Number(value);
}

function relative(args: Record<string, unknown>): string {
  if (args.path === undefined) return '';
  if (typeof args.path !== 'string') throw new TaskWeaveError('INVALID_ARGUMENTS', 'path 必须为字符串');
  return args.path;
}

export interface ToolContext { task: Task; store: StateStore; workspace: WorkspacePort; services: RuntimeServices; callKey: string; signal: AbortSignal; config?: RuntimeConfig }

export function availableTools(config: RuntimeConfig, workflow = false): ToolDefinition[] {
  const names = Object.keys(config.checks);
  return TOOL_DEFINITIONS.filter(tool => (!workflow || tool.function.name !== 'create_task') && (tool.function.name !== 'run_checks' || names.length)).map(tool => tool.function.name === 'run_checks'
    ? { ...tool, function: { ...tool.function, description: `${tool.function.description} 可选名称：${names.join(', ')}` } } : tool);
}

export async function executeTool(name: string, raw: string, ctx: ToolContext): Promise<ToolResult> {
  try {
    ctx.signal.throwIfAborted();
    if (ctx.task.workflow) {
      await assertWorkflowTask(ctx.store, ctx.task, true);
      if (name === 'create_task') throw new TaskWeaveError('WORKFLOW_MANAGED_TASK', '工作流节点由定义调度，不能创建未编排子任务');
    }
    await assertHandoff(ctx.store, ctx.workspace, ctx.task);
    if (ctx.config) await skillContext(ctx.workspace, ctx.config, ctx.task.skills);
    const definition = TOOL_DEFINITIONS.find(tool => tool.function.name === name);
    if (!definition) throw new TaskWeaveError('UNKNOWN_TOOL', `未知工具：${name}`);
    const args = argumentObject(raw);
    const allowed = Object.keys(definition.function.parameters.properties as object);
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new TaskWeaveError('INVALID_ARGUMENTS', '工具参数包含未知字段');
    const required = definition.function.parameters.required as string[];
    if (required.some(key => !(key in args))) throw new TaskWeaveError('INVALID_ARGUMENTS', '缺少必填工具参数');

    if (name === 'record_summary') return { ok: true, data: { summary: await recordSummary(ctx.task, args, ctx.workspace) } };

    if (name === 'run_checks') {
      if (!Array.isArray(args.checks) || args.checks.some(name => typeof name !== 'string')) throw new TaskWeaveError('INVALID_ARGUMENTS', 'checks 必须是命令名称数组');
      const checks = await runChecks(args.checks, { runner: ctx.services.checkRunner, store: ctx.store, taskId: ctx.task.id, key: `tool:${ctx.callKey}`, config: ctx.config ?? parseConfig({ version: 1 }), signal: ctx.signal });
      let remaining = 16_384;
      const observations = checks.map(check => {
        const stdout = check.stdout.slice(0, remaining); remaining -= stdout.length;
        const stderr = check.stderr.slice(0, remaining); remaining -= stderr.length;
        return { ...check, stdout, stderr, outputTruncated: stdout.length < check.stdout.length || stderr.length < check.stderr.length };
      });
      return { ok: checks.every(check => check.status === 'passed'), data: { checks: observations } };
    }

    if (name === 'list_files') return { ok: true, data: await ctx.workspace.walk(relative(args), integer(args.limit, 200, 1, 500)) };
    if (name === 'read_file') {
      const file = string(args, 'path');
      const value = await ctx.workspace.read(file);
      const lines = value.content.split('\n');
      const start = integer(args.start_line, 1, 1, 1_000_000);
      const end = integer(args.end_line, start + 199, start, start + 499);
      const selection = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
      return { ok: true, data: { path: file, sha256: value.hash, totalLines: lines.length, content: selection.slice(0, 20_000), truncated: end < lines.length || selection.length > 20_000 } };
    }
    if (name === 'search_files') {
      const query = string(args, 'query', 200).toLowerCase();
      const limit = integer(args.limit, 20, 1, 50);
      const tree = await ctx.workspace.walk(relative(args));
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let scannedBytes = 0;
      let skipped = 0;
      let scanned = 0;
      let truncated = tree.truncated;
      for (const file of tree.files) {
        ctx.signal.throwIfAborted();
        let value;
        try { value = await ctx.workspace.read(file); }
        catch (error) {
          if (error instanceof TaskWeaveError && ['BINARY_FILE', 'FILE_TOO_LARGE'].includes(error.code)) { skipped++; continue; }
          throw error;
        }
        scannedBytes += Buffer.byteLength(value.content);
        if (scannedBytes > 4 * 1024 * 1024) { truncated = true; break; }
        scanned++;
        for (const [index, line] of value.content.split('\n').entries()) {
          if (line.toLowerCase().includes(query)) matches.push({ path: file, line: index + 1, text: line.slice(0, 400) });
          if (matches.length >= limit) { truncated = true; break; }
        }
        if (matches.length >= limit) break;
      }
      return { ok: true, data: { matches, scanned, skipped, truncated } };
    }
    if (name === 'write_file') {
      const file = string(args, 'path');
      if (Object.values(ctx.config?.skills ?? {}).some(skill => path.posix.normalize(skill.path) === path.posix.normalize(file.replaceAll('\\', '/')))) throw new TaskWeaveError('SKILL_READ_ONLY', '模型不能修改已注册的 Skill；请由用户更新版本并创建新任务');
      if (ctx.task.handoff?.sources.some(source => source.artifacts.some(artifact => path.posix.normalize(artifact.path) === path.posix.normalize(file.replaceAll('\\', '/'))))) throw new TaskWeaveError('HANDOFF_READ_ONLY', '交接产物是本 attempt 的只读输入；需要修改时请 workflow rework 上游节点');
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 200 * 1024) throw new TaskWeaveError('INVALID_ARGUMENTS', 'content 必须为字符串，最大 200 KiB');
      const content = args.content;
      const expected = args.expected_sha256;
      if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) throw new TaskWeaveError('INVALID_ARGUMENTS', 'expected_sha256 必须是 null 或 SHA-256');
      return { ok: true, data: await ctx.workspace.write(file, content, expected, ctx.signal) };
    }
    if (name === 'create_task') {
      const title = string(args, 'title', 160);
      const goal = string(args, 'goal');
      if (!isTaskKind(args.kind)) throw new TaskWeaveError('INVALID_ARGUMENTS', '无效的任务类型');
      const criteria = args.acceptance_criteria;
      if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 12
        || criteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) throw new TaskWeaveError('INVALID_ARGUMENTS', '验收标准应为 1 到 12 条非空文本，每条最多 500 字符');
      const config = ctx.config ?? parseConfig({ version: 1 });
      const child = await createTask(ctx.store, { kind: args.kind, title, goal, acceptanceCriteria: criteria, maxSteps: ctx.task.maxSteps, contextBudget: config.context?.maxCharacters, validationPolicy: config.validation[args.kind] ?? DEFAULT_VALIDATION, executionConfigHash: configHash(config) }, ctx.task.provider, ctx.task.id, ctx.callKey);
      return { ok: true, data: { taskId: child.id, title: child.title, status: child.status, kind: child.kind } };
    }
    throw new TaskWeaveError('INTERACTIVE_TOOL', 'ask_user 由运行内核处理');
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { ok: false, error: { code: error instanceof TaskWeaveError ? error.code : 'TOOL_IO_ERROR', message: errorMessage(error) } };
  }
}
