import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { hasCode, sha256, TaskWeaveError } from '@taskweave/core';
import type { ReadStateStore, WorkspacePort } from '@taskweave/core/ports';
import type { TaskEvent, WorkflowEvent } from '@taskweave/contracts';
import { Workspace } from '../../workspace/local/workspace.ts';
import { decodeTask, decodeWorkflow } from './snapshots.ts';

/** Bound reads and refuse final-component links. No operation in this module creates a file. */
async function readRegular(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TaskWeaveError('STATE_PATH_DENIED', '只能读取普通文件');
    if (info.size > limit) throw new TaskWeaveError('FILE_TOO_LARGE', '文件超过读取上限');
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    // Concurrent growth must not return a truncated JSON or an incorrect artifact hash.
    if (length !== info.size) throw new TaskWeaveError('READ_CHANGED', '文件读取期间发生变化，请重新查询');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

const taskId = /^tw_[a-f0-9]{24}$/;
const workflowId = /^wf_[a-f0-9]{24}$/;
export class FileStateReader implements ReadStateStore {
  private constructor(readonly workspace: string) {}
  static async open(workspace: string): Promise<FileStateReader> {
    const reader = new FileStateReader(await realpath(workspace));
    await reader.directory('tasks');
    return reader;
  }
  private async directory(section: string): Promise<string> {
    let current = this.workspace;
    for (const part of ['', '.taskweave', section]) {
      current = path.join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new TaskWeaveError('STATE_PATH_DENIED', '状态目录必须是普通目录');
    }
    return current;
  }
  private async read(section: string, id: string, extension: string): Promise<string> {
    if (!(section === 'workflows' ? workflowId : taskId).test(id)) throw new TaskWeaveError('INVALID_ID', '无效的任务或工作流 ID');
    const directory = await this.directory(section);
    return (await readRegular(path.join(directory, `${id}.${extension}`), extension === 'json' ? 8 * 1024 * 1024 : 16 * 1024 * 1024)).toString('utf8');
  }
  private async ids(section: 'tasks' | 'workflows'): Promise<string[]> {
    let directory;
    try { directory = await this.directory(section); }
    catch (error) { if (section === 'workflows' && hasCode(error, 'ENOENT')) return []; throw error; }
    const names = (await readdir(directory)).filter(name => (section === 'tasks' ? /^tw_[a-f0-9]{24}\.json$/ : /^wf_[a-f0-9]{24}\.json$/).test(name));
    if (names.length > 5_000) throw new TaskWeaveError('COLLECTION_LIMIT', '当前文件查询最多支持 5,000 个快照');
    return names.map(name => name.slice(0, -5));
  }
  async load(id: string) {
    const task = decodeTask(await this.read('tasks', id, 'json'), id, this.workspace);
    if (!Number.isSafeInteger(task.seq) || task.seq < 0) throw new TaskWeaveError('CORRUPT_TASK', '任务观察序号无效');
    return task;
  }
  async loadWorkflow(id: string) { return decodeWorkflow(await this.read('workflows', id, 'json'), id, this.workspace); }
  async list() {
    const tasks = [];
    for (const id of await this.ids('tasks')) tasks.push(await this.load(id));
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  async listWorkflows() {
    const runs = [];
    for (const id of await this.ids('workflows')) runs.push(await this.loadWorkflow(id));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  private async log<T extends { seq: number }>(section: string, id: string, after: number): Promise<T[]> {
    let content;
    try { content = await this.read(section, id, 'jsonl'); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    const lines = content.split('\n'); lines.pop(); // Ignore an uncommitted tail; never repair it.
    return lines.filter(Boolean).map(line => JSON.parse(line) as T).filter(event => event.seq > after);
  }
  events(id: string, after = 0) { return this.log<TaskEvent>('events', id, after); }
  workflowEvents(id: string, after = 0) { return this.log<WorkflowEvent>('workflows', id, after); }
}

export class ReadOnlyWorkspace implements Pick<WorkspacePort, 'root' | 'read'> {
  constructor(readonly root: string) {}
  async read(file: string) {
    const target = await new Workspace(this.root).resolve(file);
    const bytes = await readRegular(target, 512 * 1024);
    if (bytes.includes(0)) throw new TaskWeaveError('BINARY_FILE', '只支持文本产物');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new TaskWeaveError('BINARY_FILE', '只支持 UTF-8 文本产物'); }
    return { content, hash: sha256(bytes) };
  }
}
