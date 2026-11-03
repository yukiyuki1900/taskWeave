import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hasCode, parseConfig, TaskWeaveError } from '@taskweave/core';
import { configRelativePath } from '@taskweave/core/config';
import type { RuntimeConfig } from '@taskweave/core/types';

const fail = (): never => { throw new TaskWeaveError('INVALID_CONFIG', '验证配置无效，请参考 docs/validation.md'); };

/** Only the operator loads this file. File tools cannot access the hidden state directory. */
export async function loadConfig(workspace: string, file = '.taskweave/config.json'): Promise<RuntimeConfig> {
  configRelativePath(file, true);
  let current = workspace;
  const parts = file.split('/').filter(part => part && part !== '.');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (hasCode(error, 'ENOENT') && file === '.taskweave/config.json') return parseConfig({ version: 1 });
      throw error;
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.size > 65_536)) return fail();
  }
  if (!parts.length) return fail();
  try { return parseConfig(JSON.parse(await readFile(current, 'utf8'))); }
  catch (error) { if (error instanceof TaskWeaveError) throw error; return fail(); }
}
