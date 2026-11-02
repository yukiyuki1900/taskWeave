import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, hasCode, sha256 } from './files.ts';
import { systemPrompt } from './presets.ts';
import { isTaskKind, TaskWeaveError } from './types.ts';
import type { Task, TaskEvent, TaskInput, ToolResult } from './types.ts';

const ID = /^tw_[a-f0-9]{24}$/;
const now = (): string => new Date().toISOString();

export class TaskStore {
  private constructor(readonly workspace: string, readonly directory: string) {}

  static async open(workspace: string): Promise<TaskStore> {
    await mkdir(path.resolve(workspace), { recursive: true });
    const root = await realpath(workspace);
    const directory = path.join(root, '.taskweave');
    for (const part of [directory, ...['tasks', 'events', 'receipts'].map(name => path.join(directory, name))]) {
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
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt: now() }));
      await handle.sync();
      return await action();
    } finally {
      await handle.close();
      await unlink(file);
    }
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

  /** Caller holds the workspace lock for every mutation. */
  async create(input: TaskInput, provider: string, parentId?: string, callKey?: string): Promise<Task> {
    if (!isTaskKind(input.kind) || !input.goal.trim() || input.goal.length > 20_000) throw new TaskWeaveError('INVALID_TASK', '任务类型或目标无效（目标最多 20,000 字符）');
    const maxSteps = input.maxSteps ?? 24;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) throw new TaskWeaveError('INVALID_BUDGET', 'maxSteps 必须在 1 到 200 之间');
    const id = callKey && parentId ? `tw_${sha256(`${parentId}:${callKey}`).slice(0, 24)}` : `tw_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    if (callKey) {
      try { return await this.load(id); }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    }
    const task: Task = {
      version: 1, id, kind: input.kind,
      title: input.title?.trim().slice(0, 160) || input.goal.trim().slice(0, 80),
      goal: input.goal.trim(), acceptanceCriteria: input.acceptanceCriteria ?? [],
      ...(parentId ? { parentId } : {}),
      status: 'pending', provider, workspace: this.workspace,
      createdAt: now(), updatedAt: now(), seq: 0, steps: 0, maxSteps,
      messages: [{ role: 'system', content: systemPrompt(input) }, { role: 'user', content: input.goal.trim() }],
      pendingCalls: [], artifacts: [], childTaskIds: [], usage: { input: 0, output: 0 }
    };
    await this.emit(task, 'task.created', { kind: task.kind, title: task.title });
    return task;
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
}
