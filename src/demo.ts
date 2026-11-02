import { sha256 } from './files.ts';
import { PRESETS } from './presets.ts';
import type { Message, ModelProvider, ModelTurn, TaskKind, ToolCall } from './types.ts';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** A deterministic fixture for trying the runtime. It does not call or simulate an LLM. */
export class DemoProvider implements ModelProvider {
  readonly id = 'demo:v1';
  constructor(private kind: TaskKind) {}

  async complete(messages: Message[], _tools: unknown, signal: AbortSignal): Promise<ModelTurn> {
    signal.throwIfAborted();
    const goal = messages.find(message => message.role === 'user')?.content ?? '';
    const rounds = messages.filter(message => message.role === 'assistant').length;
    const suffix = sha256(goal).slice(0, 8);
    const file = this.kind === 'code' ? `generated/normalize-title-${suffix}.ts` : `artifacts/${this.kind}-${suffix}.md`;
    if (rounds === 0) return { content: '离线脚本演示：先查看工作区文件。', toolCalls: [call('demo-list', 'list_files', { limit: 20 })] };
    if (rounds === 1) {
      const content = this.kind === 'code'
        ? '// TaskWeave 离线演示固定示例；不是根据任务目标生成的业务实现。\nexport function normalizeTitle(value: string): string {\n  return value.trim().replace(/\\s+/g, " ");\n}\n'
        : this.document(goal);
      const calls = [call('demo-artifact', 'write_file', { path: file, content, expected_sha256: null })];
      if (this.kind === 'requirements') {
        calls.push(call('demo-code-task', 'create_task', {
          kind: 'code', title: '实现需求中的核心流程',
          goal: `依据 ${file} 实现最小可用版本。原始目标：${goal}`,
          acceptance_criteria: ['核心用户流程可完成', '关键输入有校验', '交付改动说明与验证建议']
        }));
      }
      if (this.kind === 'requirements' || this.kind === 'tests') {
        calls.push(call('demo-test-task', 'create_task', {
          kind: 'tests', title: '设计核心流程测试场景',
          goal: `依据 ${file} 设计可执行的测试场景，覆盖正常、边界和异常路径。`,
          acceptance_criteria: ['每条用例有步骤和预期结果', '包含至少一个异常场景', '明确未实际执行测试']
        }));
      }
      return { content: '离线脚本演示：写入产物并建立待执行任务。', toolCalls: calls };
    }
    const failures = messages.filter(message => message.role === 'tool' && message.content && !JSON.parse(message.content).ok);
    return {
      content: failures.length
        ? `离线脚本演示已结束，其中 ${failures.length} 个工具调用失败，请查看事件与工具结果。此演示不调用模型，也不自动修复错误。`
        : `离线脚本演示已完成：生成 ${file}。子任务如有创建，状态为 pending，可使用 list 查看并显式 resume 执行。未调用真实模型，未运行任何测试或 Shell 命令。`,
      toolCalls: []
    };
  }

  private document(goal: string): string {
    const prefix = `# ${PRESETS[this.kind].label}\n\n> TaskWeave 离线脚本演示。以下为固定模板，尚未经模型分析或业务确认。\n\n## 任务目标\n\n${goal}\n\n`;
    if (this.kind === 'requirements') return prefix + [
      '## 范围与假设',
      '假设先服务单一团队；账号、权限和部署方式需要后续确认。',
      '## 用户故事',
      '- 用户可以创建任务，并查看当前负责人、截止时间和状态。',
      '- 负责人可以更新任务状态，团队成员可以查阅进展。',
      '## 验收标准',
      '- 创建任务时标题不能为空。',
      '- 状态修改后再次读取仍保留最新值。',
      '- 无权限用户不能修改任务。',
      '## 后续工作',
      '实现与测试任务已通过 create_task 建立，尚未执行。'
    ].join('\n\n') + '\n';
    if (this.kind === 'tests') return prefix + [
      '## 测试计划',
      '| 场景 | 前置条件 | 操作 | 预期结果 |',
      '| --- | --- | --- | --- |',
      '| 正常创建 | 用户有权限 | 填写有效标题并提交 | 创建成功且可查询 |',
      '| 空标题 | 用户有权限 | 提交空白标题 | 拒绝并展示原因 |',
      '| 无权限修改 | 用户仅有查看权限 | 尝试修改状态 | 拒绝且原数据保持 |',
      '## 执行状态',
      '尚未执行。此产物只演示测试设计的交付形式。'
    ].join('\n') + '\n';
    return prefix + '## 交付说明\n\n本文件演示工作区产物写入、哈希校验与事件记录。配置模型后可以依据真实资料生成内容。\n';
  }
}
