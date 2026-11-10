import type {
  Message,
  ModelProvider,
  ModelTurn,
  ToolCall,
  WorkflowNodeDefinition,
} from '@taskweave/core/types';

const paths: Record<string, string> = {
  requirements: 'artifacts/requirements.json',
  implementation: 'src/normalize-title.mjs',
  tests: 'tests/normalize-title.test.mjs',
  documentation: 'README.md',
  overview: 'artifacts/overview.md',
};
const tests = `import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTitle } from '../src/normalize-title.mjs';
for (const [input, expected] of [['', ''], ['   ', ''], ['  hello  ', 'hello'], ['a   b', 'a b'], ['a\\nb', 'a b']]) {
  test(JSON.stringify(input), () => assert.equal(normalizeTitle(input), expected));
}
`;
function content(id: string, revision: number, broken: boolean): string {
  if (id === 'requirements')
    return (
      JSON.stringify(
        {
          scope: `标题规范化，修订 ${revision}，仅处理字符串输入`,
          stories: ['使用者获得适合展示的标题'],
          rules: ['去除首尾空白', '连续内部空白归一为空格', '全空白返回空字符串'],
          acceptance: ['空字符串', '全空白', '首尾空白', '连续空白', '换行'],
          ...(revision === 2 ? { clarification: '返工说明：换行与制表符均属于内部空白' } : {}),
        },
        null,
        2,
      ) + '\n'
    );
  if (id === 'implementation')
    return broken
      ? '// 固定脚本故意交付错误版本，以演示独立验证失败。\nexport function normalizeTitle(value) { return value; }\n'
      : '// 固定脚本示例，不是模型生成的业务代码。\nexport function normalizeTitle(value) { return value.trim().replace(/\\s+/g, " "); }\n';
  if (id === 'tests') return tests;
  if (id === 'overview')
    return '# TaskWeave 完整演示\n\n此任务由固定脚本运行，不调用模型。\n\n展示需求、代码、测试与文档的统一交付与验收链。\n';
  return `# 标题规范化（脚本演示，修订 ${revision}）

## 使用说明

仅支持字符串输入。导入 src/normalize-title.mjs 的 normalizeTitle，去除首尾空白并将连续空白归一为空格。

## 验证结果

上游测试节点已通过独立配置的 regression 检查，具体状态、退出码与耗时见验证记录。录制工具不把脚本效果当作真实模型效果。

执行命令：node --test tests/normalize-title.test.mjs

## 限制

不支持非字符串输入；没有产物版本库；本文件由固定脚本写入，仍需人工核对。
`;
}
function result(messages: Message[], id: string): Record<string, any> | undefined {
  const message = messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === id,
  );
  return message?.content ? JSON.parse(message.content) : undefined;
}
function tool(id: string, name: string, args: Record<string, unknown>): ModelTurn {
  const call: ToolCall = {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
  return {
    content: '固定脚本演示：执行预设交付步骤。',
    toolCalls: [call],
    usage: { input: 0, output: 0 },
  };
}
/** Not a language model. All content, failures and questions are deliberately scripted. */
export class ShowcaseProvider implements ModelProvider {
  readonly id = 'demo:showcase:v1';
  constructor(
    private node: Pick<WorkflowNodeDefinition, 'id' | 'dependsOn'>,
    private revision: number,
    private broken = false,
  ) {}
  async complete(messages: Message[], _tools: unknown, signal: AbortSignal): Promise<ModelTurn> {
    signal.throwIfAborted();
    const list = result(messages, 'show-list');
    if (!list) return tool('show-list', 'list_files', { limit: 100 });
    const file = paths[this.node.id];
    const files = list.data.files as string[];
    if (files.includes(file) && !result(messages, 'show-own'))
      return tool('show-own', 'read_file', { path: file });
    const source = this.node.dependsOn[0];
    if (source && !result(messages, 'show-source'))
      return tool('show-source', 'read_file', { path: paths[source] });
    if (this.node.id === 'documentation' && !result(messages, 'show-question'))
      return tool('show-question', 'ask_user', {
        question: '使用说明采用中文还是英文？（固定脚本演示问题）',
      });
    if (!result(messages, 'show-write'))
      return tool('show-write', 'write_file', {
        path: file,
        content: content(this.node.id, this.revision, this.broken),
        expected_sha256: result(messages, 'show-own')?.data.sha256 ?? null,
      });
    const failed = messages.some(
      (message) =>
        message.role === 'tool' && message.content && JSON.parse(message.content).ok === false,
    );
    if (failed) throw new Error('固定演示工具步骤意外失败，停止录制');
    return {
      content: `固定脚本已交付 ${file}。最终状态以引擎独立验证与验收记录为准；未调用真实模型。`,
      toolCalls: [],
      usage: { input: 0, output: 0 },
    };
  }
}
