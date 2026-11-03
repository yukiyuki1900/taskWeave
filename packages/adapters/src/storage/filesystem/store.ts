import { hostname } from 'node:os';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { atomicWrite } from './atomic-write.ts';
import { hasCode, sha256 } from '@taskweave/core';
import type { StateStore } from '@taskweave/core/ports';
import { isTaskKind, TaskWeaveError } from '@taskweave/core/types';
import type { Task, TaskEvent, ToolResult } from '@taskweave/core/types';
import type { WorkflowEvent, WorkflowRun } from '@taskweave/contracts';
import { parseWorkflow } from '@taskweave/core';

const ID = /^tw_[a-f0-9]{24}$/;
const now = (): string => new Date().toISOString();

export class TaskStore implements StateStore {
  private lockContext = new AsyncLocalStorage<{ active: boolean }>();
  private constructor(readonly workspace: string, readonly directory: string) {}

  static async open(workspace: string): Promise<TaskStore> {
    await mkdir(path.resolve(workspace), { recursive: true });
    const root = await realpath(workspace);
    const directory = path.join(root, '.taskweave');
    for (const part of [directory, ...['tasks', 'events', 'receipts', 'check-runs', 'workflows'].map(name => path.join(directory, name))]) {
      await mkdir(part, { mode: 0o700 }).catch(error => { if (!hasCode(error, 'EEXIST')) throw error; });
      const info = await lstat(part);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new TaskWeaveError('STATE_PATH_DENIED', '状态目录必须是普通目录');
    }
    return new TaskStore(root, directory);
  }

  private file(id: string, section: 'tasks' | 'events', extension: string): string {
    if (!ID.test(id)) throw new TaskWeaveError('INVALID_TASK_ID', '无效的任务 ID');
    return path.join(this.directory, section, `${id}.${extension}`);
  }

  async withLock<T>(action: () => Promise<T>): Promise<T> {
    const file = path.join(this.directory, 'run.lock');
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (hasCode(error, 'EEXIST')) throw new TaskWeaveError('WORKSPACE_BUSY', '工作区已有执行器或遗留锁；确认进程退出后使用 unlock');
      throw error;
    }
    const token = { active: true };
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt: now() }));
      await handle.sync();
      return await this.lockContext.run(token, action);
    } finally {
      token.active = false;
      await handle.close();
      await unlink(file);
    }
  }

  assertLocked(): void {
    if (!this.lockContext.getStore()?.active) throw new TaskWeaveError('LOCK_REQUIRED', '内部操作必须持有当前工作区锁');
  }

  async unlock(): Promise<void> {
    const file = path.join(this.directory, 'run.lock');
    let info;
    try { info = await lstat(file); }
    catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new TaskWeaveError('LOCK_INVALID', '锁文件类型无效');
    const value = JSON.parse(await readFile(file, 'utf8')) as { pid?: number; host?: string };
    if (value.host !== hostname() || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1) {
      throw new TaskWeaveError('LOCK_INVALID', '无法确认锁归属，不会自动删除');
    }
    try {
      process.kill(value.pid!, 0);
      throw new TaskWeaveError('WORKSPACE_BUSY', '锁所属进程仍然存活');
    } catch (error) {
      if (!hasCode(error, 'ESRCH')) throw error;
    }
    const current = await lstat(file);
    if (current.ino !== info.ino || current.mtimeMs !== info.mtimeMs) throw new TaskWeaveError('WORKSPACE_BUSY', '锁已变化，请重新检查');
    await unlink(file);
  }

  private workflowFile(id: string, extension: 'json' | 'jsonl'): string {
    if (!/^wf_[a-f0-9]{24}$/.test(id)) throw new TaskWeaveError('INVALID_WORKFLOW_ID', '无效工作流 ID');
    return path.join(this.directory, 'workflows', `${id}.${extension}`);
  }

  async loadWorkflow(id: string): Promise<WorkflowRun> {
    const run = JSON.parse(await readFile(this.workflowFile(id, 'json'), 'utf8')) as WorkflowRun;
    if (run.version !== 1 || run.id !== id || run.workspace !== this.workspace || !Array.isArray(run.nodes) || !Number.isSafeInteger(run.seq)) throw new TaskWeaveError('CORRUPT_WORKFLOW', '工作流快照无效或属于其他工作区');
    const definition = parseWorkflow(run.definition);
    if (run.nodes.length !== definition.nodes.length || run.nodes.some((node, index) => node.id !== definition.nodes[index].id || !Array.isArray(node.attempts))) throw new TaskWeaveError('CORRUPT_WORKFLOW', '工作流节点快照无效');
    return run;
  }

  async listWorkflows(): Promise<WorkflowRun[]> {
    const files = await readdir(path.join(this.directory, 'workflows'));
    const runs = await Promise.all(files.filter(file => /^wf_[a-f0-9]{24}\.json$/.test(file)).map(file => this.loadWorkflow(file.slice(0, -5))));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveWorkflow(run: WorkflowRun): Promise<void> {
    this.assertLocked();
    run.updatedAt = now();
    await atomicWrite(this.workflowFile(run.id, 'json'), JSON.stringify(run, null, 2) + '\n');
  }

  async workflowEvents(id: string, after = 0): Promise<WorkflowEvent[]> {
    let text;
    try { text = await readFile(this.workflowFile(id, 'jsonl'), 'utf8'); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    const lines = text.split('\n'); lines.pop();
    return lines.filter(Boolean).map(line => JSON.parse(line) as WorkflowEvent).filter(event => event.seq > after);
  }

  async emitWorkflow(run: WorkflowRun, type: string, data: Record<string, unknown> = {}): Promise<WorkflowEvent> {
    this.assertLocked();
    const history = await this.workflowEvents(run.id);
    run.seq = Math.max(run.seq, history.at(-1)?.seq ?? 0) + 1;
    const event: WorkflowEvent = { runId: run.id, seq: run.seq, time: now(), type, data };
    const handle = await open(this.workflowFile(run.id, 'jsonl'), 'a+', 0o600);
    try {
      const previous = await handle.readFile();
      const committedBytes = previous.lastIndexOf(10) + 1;
      if (committedBytes < previous.length) await handle.truncate(committedBytes);
      await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync();
    } finally { await handle.close(); }
    await this.saveWorkflow(run);
    return event;
  }

  async load(id: string): Promise<Task> {
    const value = JSON.parse(await readFile(this.file(id, 'tasks', 'json'), 'utf8')) as Task;
    if (value.version !== 1 || value.id !== id || value.workspace !== this.workspace || !isTaskKind(value.kind)
      || !Array.isArray(value.messages) || !Array.isArray(value.pendingCalls) || !Number.isSafeInteger(value.steps)) {
      throw new TaskWeaveError('CORRUPT_TASK', '任务快照无效或属于其他工作区');
    }
    return value;
  }

  async list(): Promise<Task[]> {
    const files = await readdir(path.join(this.directory, 'tasks'));
    const tasks = await Promise.all(files.filter(name => /^tw_[a-f0-9]{24}\.json$/.test(name)).map(name => this.load(name.slice(0, -5))));
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  async save(task: Task): Promise<void> {
    task.updatedAt = now();
    await atomicWrite(this.file(task.id, 'tasks', 'json'), JSON.stringify(task, null, 2) + '\n');
  }

  async events(id: string, after = 0): Promise<TaskEvent[]> {
    let text;
    try { text = await readFile(this.file(id, 'events', 'jsonl'), 'utf8'); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    // A process may be killed mid-append. Ignore only the uncommitted final fragment.
    const lines = text.split('\n');
    lines.pop();
    return lines.filter(Boolean).map(line => JSON.parse(line) as TaskEvent).filter(event => event.seq > after);
  }

  async emit(task: Task, type: string, data: Record<string, unknown> = {}): Promise<TaskEvent> {
    const history = await this.events(task.id);
    task.seq = Math.max(task.seq, history.at(-1)?.seq ?? 0) + 1;
    const event: TaskEvent = { taskId: task.id, seq: task.seq, time: now(), type, data };
    const handle = await open(this.file(task.id, 'events', 'jsonl'), 'a+', 0o600);
    try {
      const previous = await handle.readFile();
      const committedBytes = previous.lastIndexOf(10) + 1;
      if (committedBytes < previous.length) await handle.truncate(committedBytes);
      await handle.writeFile(JSON.stringify(event) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await this.save(task);
    return event;
  }

  private receiptFile(taskId: string, callKey: string): string {
    if (!ID.test(taskId)) throw new TaskWeaveError('INVALID_TASK_ID', '无效的任务 ID');
    return path.join(this.directory, 'receipts', `${taskId}-${sha256(callKey)}.json`);
  }

  async receipt(taskId: string, callKey: string): Promise<ToolResult | null> {
    try { return JSON.parse(await readFile(this.receiptFile(taskId, callKey), 'utf8')) as ToolResult; }
    catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
  }

  async saveReceipt(taskId: string, callKey: string, result: ToolResult): Promise<void> {
    await atomicWrite(this.receiptFile(taskId, callKey), JSON.stringify(result) + '\n');
  }

  async checkRecord<T>(taskId: string, key: string): Promise<T | null> {
    if (!ID.test(taskId)) throw new TaskWeaveError('INVALID_TASK_ID', '无效的任务 ID');
    try { return JSON.parse(await readFile(path.join(this.directory, 'check-runs', `${taskId}-${sha256(key)}.json`), 'utf8')) as T; }
    catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
  }

  async saveCheckRecord(taskId: string, key: string, record: unknown): Promise<void> {
    if (!ID.test(taskId)) throw new TaskWeaveError('INVALID_TASK_ID', '无效的任务 ID');
    await atomicWrite(path.join(this.directory, 'check-runs', `${taskId}-${sha256(key)}.json`), JSON.stringify(record) + '\n');
  }
}
