import { FileStateReader, ReadOnlyWorkspace } from '@taskweave/adapters';
import { createReadApi } from './app.ts';
import type { ApiOptions } from './app.ts';

export async function createLocalReadApi(workspace: string, options: ApiOptions = {}) {
  const reader = await FileStateReader.open(workspace);
  return createReadApi(reader, new ReadOnlyWorkspace(reader.workspace), options);
}
