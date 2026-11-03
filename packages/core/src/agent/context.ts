import type { Message, Task } from '../types.ts';
import { TaskWeaveError } from '../types.ts';

/** Drop only whole old assistant/tool rounds; full originals remain in the checkpoint. */
export function buildContext(task: Task, maxCharacters = 80_000): { messages: Message[]; archivedRounds: number } {
  const prefix = task.messages.slice(0, 2);
  const groups: Message[][] = [];
  for (const message of task.messages.slice(2)) {
    if (message.role === 'assistant' || !groups.length) groups.push([]);
    groups.at(-1)!.push(message);
  }
  const originalRounds = groups.length;
  const manifest: Message = {
    role: 'user',
    content: '较早的执行轮次已归档到本地检查点。以下是已交付文件和子任务，必要时重新读取文件，不应假设归档内容。\n'
      + JSON.stringify({ artifacts: task.artifacts, childTaskIds: task.childTaskIds })
  };
  const current = (): Message[] => [...prefix, ...(groups.length < originalRounds ? [manifest] : []), ...groups.flat()];
  while (JSON.stringify(current()).length > maxCharacters && groups.length > 1) groups.shift();
  const messages = current();
  if (JSON.stringify(messages).length > maxCharacters) throw new TaskWeaveError('CONTEXT_LIMIT', '目标与最近执行轮次超过上下文字符预算，请缩小任务或减少单次工具内容');
  return { messages, archivedRounds: originalRounds - groups.length };
}
