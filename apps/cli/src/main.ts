import { taskMain } from './commands/task.ts';
import { workflowMain } from './commands/workflow.ts';
import { defaultIO } from './presentation/task.ts';
import type { IO } from './presentation/task.ts';

export async function main(argv: string[], io: IO = defaultIO): Promise<number> {
  return argv[0] === 'workflow' ? workflowMain(argv.slice(1), io) : taskMain(argv, io);
}
