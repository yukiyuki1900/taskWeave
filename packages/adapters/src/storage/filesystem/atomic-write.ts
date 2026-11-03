import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hasCode } from '@taskweave/core';

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
