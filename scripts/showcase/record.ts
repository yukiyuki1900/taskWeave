import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { recordShowcase } from './scenario.ts';

const { values } = parseArgs({
  options: { output: { type: 'string' }, workspace: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help)
  console.log(
    '用法：npm run showcase:record -- [--workspace <全新目录>] [--output .cache/showcase/session.json]\n固定脚本录制；会实际运行示例的 Node 检查，不调用模型，不监听端口。',
  );
else {
  const output = path.resolve(values.output ?? '.cache/showcase/session.json');
  const workspace = path.resolve(values.workspace ?? `.cache/showcase/work-${Date.now()}`);
  await mkdir(path.dirname(workspace), { recursive: true });
  const recording = await recordShowcase(workspace);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(recording) + '\n');
  console.log(
    JSON.stringify(
      {
        output,
        workspace,
        runId: recording.runId,
        frames: recording.frames.length,
        provenance: recording.provenance,
      },
      null,
      2,
    ),
  );
}
