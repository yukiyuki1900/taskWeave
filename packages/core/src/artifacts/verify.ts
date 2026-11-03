import { errorMessage } from '../errors.ts';
import type { Artifact, ValidationItem } from '@taskweave/contracts';
import type { WorkspacePort } from '../ports/index.ts';

export async function verifyArtifacts(workspace: WorkspacePort, artifacts: Artifact[], signal: AbortSignal): Promise<ValidationItem[]> {
  const items: ValidationItem[] = [];
  for (const artifact of artifacts) {
    signal.throwIfAborted();
    try {
      const file = await workspace.read(artifact.path);
      items.push({ name: `artifact:${artifact.path}`, passed: file.hash === artifact.sha256, detail: file.hash === artifact.sha256 ? `sha256:${file.hash}` : '产物已发生变化，与生成记录不一致' });
    } catch (error) { items.push({ name: `artifact:${artifact.path}`, passed: false, detail: errorMessage(error) }); }
  }
  return items;
}
