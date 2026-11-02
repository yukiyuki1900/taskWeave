import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TaskWeaveError } from './types.ts';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Same-directory replacement avoids partial reads and writing through hard links. */
export async function atomicWrite(file: string, contents: string, mode = 0o600): Promise<void> {
  const temporary = path.join(path.dirname(file), `.taskweave-write-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (!hasCode(error, 'ENOENT')) throw error; });
  }
}

const SKIP_NAMES = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage']);
function forbidden(part: string): boolean {
  return part.startsWith('.') || SKIP_NAMES.has(part) || /\.(pem|key|p12|pfx)$/i.test(part);
}

export class Workspace {
  constructor(readonly root: string) {}

  /** Reject symlinks, including links inside the root. This is a path guard, not an OS sandbox. */
  async resolve(relative: string, createParents = false): Promise<string> {
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || relative.includes('\\')) {
      throw new TaskWeaveError('PATH_DENIED', '必须使用工作区相对路径');
    }
    const parts = relative.split('/').filter(part => part && part !== '.');
    if (parts.some(part => part === '..' || forbidden(part))) {
      throw new TaskWeaveError('PATH_DENIED', '禁止访问父目录、隐藏文件、凭据或依赖目录');
    }
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        if (createParents && index < parts.length - 1) {
          await mkdir(current);
          info = await lstat(current);
        } else if (index < parts.length - 1) {
          throw new TaskWeaveError('NOT_FOUND', '路径中的目录不存在');
        }
      }
      if (info?.isSymbolicLink()) throw new TaskWeaveError('PATH_DENIED', '工具不跟随符号链接');
      if (info && index < parts.length - 1 && !info.isDirectory()) throw new TaskWeaveError('INVALID_PATH', '父路径必须是目录');
    }
    return current;
  }

  async walk(relative = '', limit = 500): Promise<{ files: string[]; truncated: boolean }> {
    const start = await this.resolve(relative);
    const info = await lstat(start);
    if (info.isFile()) return { files: [path.relative(this.root, start).split(path.sep).join('/')], truncated: false };
    if (!info.isDirectory()) throw new TaskWeaveError('INVALID_PATH', '仅支持普通文件和目录');
    const files: string[] = [];
    const queue = [start];
    let visited = 0;
    while (queue.length) {
      const directory = queue.shift()!;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++visited > 5_000 || files.length >= limit) return { files, truncated: true };
        if (forbidden(entry.name) || entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name);
        if (entry.isFile()) files.push(path.relative(this.root, full).split(path.sep).join('/'));
        else if (entry.isDirectory() && path.relative(start, full).split(path.sep).length <= 8) queue.push(full);
      }
    }
    return { files, truncated: false };
  }

  async read(relative: string): Promise<{ content: string; hash: string }> {
    const file = await this.resolve(relative);
    const info = await lstat(file);
    if (!info.isFile()) throw new TaskWeaveError('INVALID_PATH', '目标必须是普通文件');
    if (info.size > 512 * 1024) throw new TaskWeaveError('FILE_TOO_LARGE', '文件超过 512 KiB，请先拆分资料');
    const bytes = await readFile(file);
    if (bytes.includes(0)) throw new TaskWeaveError('BINARY_FILE', '只支持 UTF-8 文本文件');
    return { content: bytes.toString('utf8'), hash: sha256(bytes) };
  }
}
