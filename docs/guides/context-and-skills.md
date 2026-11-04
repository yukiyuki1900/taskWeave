# v0.4：上下文交接、任务摘要与本地 Skill

v0.4 面向本地 CLI，不需要服务或数据库。数据格式仍为 version 1，新增字段均为可选项；省略新配置时，v0.3 配置指纹保持不变。旧任务恢复时保留原始目标和消息，不重写历史；新建下游任务使用结构化交接。

## 快速体验

在仓库根目录安装依赖后，创建一个新工作区。已有运行绑定了原配置，不要直接修改其配置来试用新功能。

```bash
mkdir -p work/v04-001/.taskweave work/v04-001/skills/doc-style
cp examples/context/config.json work/v04-001/.taskweave/config.json
cp examples/context/skills/doc-style/SKILL.md work/v04-001/skills/doc-style/SKILL.md
node bin/taskweave.mjs skills list --workspace work/v04-001
node bin/taskweave.mjs skills show doc-style --workspace work/v04-001

# 真实模型执行，沿用 .env 中现有的模型配置
node --env-file=.env bin/taskweave.mjs workflow run \
  --file examples/context/delivery.json --workspace work/v04-001 --timeout 600
```

需求节点通过检查后等待人工验收。按输出中的 run、node、attempt ID 执行 `workflow accept`，再自动启动后续节点；文档节点同样需要人工验收。只有文档节点选择了 doc-style Skill。示例包含真实产物规则和检查命令，不能用固定脚本 `--demo` 代替模型生成这些指定产物。

单任务可使用离线演示检查 Skill 的绑定与摘要落盘，不代表模型理解了 Skill：

```bash
node bin/taskweave.mjs run --demo --kind document \
  --prompt "生成使用说明" --skill doc-style --workspace work/v04-001 --json
node bin/taskweave.mjs summary <task-id> --workspace work/v04-001 --json
node bin/taskweave.mjs show <task-id> --workspace work/v04-001 --json
```

工作流节点 task ID 见 `workflow show <run-id> --json` 的当前 attempt；`summary <task-id>` 返回摘要、交接包、Skill 绑定及 `evidenceCurrent`。该命令只读且不需要模型密钥；`evidenceCurrent` 是摘要源消息与引用文件的当前一致性，不代表业务正确、整个工作流状态有效或已经人工验收。`show --json` 展示持久化快照，运行时才会记录摘要失效状态。

## 结构化交接

下游 Task 的 `handoff` 包含：

- runId、nodeId 和完整载荷 digest；交接 JSON 最多 32,000 字符，超限明确失败，不截断 JSON。
- 每个直接依赖的 nodeId、attemptId、taskId。
- 上游任务摘要、记录过的产物路径及 SHA-256、独立验证 ID、验证条目和人工验收决定（如有）。

调度器仅从当前已完成且通过验证的上游任务创建交接。恢复、模型请求、工具执行和最终验证会检查来源 attempt、验证记录及产物 hash。旧 attempt 仍由原有工作流守卫拦截；上游返工后重新生成下游 attempt 和交接包。

本版本没有产物快照或独立 worktree：**直接交接的产物是当前 attempt 的只读输入**，模型 `write_file` 不能修改它们。测试节点可读取源码、创建自己的测试文件；发现上游错误时，由用户 `workflow rework` 对应上游节点。外部修改这些输入会导致 `STALE_HANDOFF`，需要恢复原文件或显式返工。用户配置的检查命令具有宿主权限，仍可能改文件；最终验证会再次校验输入一致性。

## 带证据的任务摘要

模型可调用 `record_summary`，包含四个数组：`facts`、`decisions`、`constraints`、`open_questions`。每组最多 8 条，每条 text 最多 600 字符并提供 1～5 个 evidence；工具参数总计最多 12,000 字符。例如：

```json
{
  "facts": [{ "text": "输入只处理字符串", "evidence": [{ "kind": "goal" }] }],
  "decisions": [],
  "constraints": [],
  "open_questions": []
}
```

支持三种模型引用：`goal`；本任务产物 `{ "kind": "artifact", "path": "result.md", "sha256": "完整hash" }`；此前轮次已完成的工具结果 `{ "kind": "tool", "call_id": "原调用ID" }`。运行时解析并保存真实 hash 与消息位置，拒绝不存在的观测和不匹配产物。引用证明来源，不自动证明模型对证据的理解正确。

`summary.kind=model` 表示模型提炼；最终验证阶段若没有有效模型摘要，会产生 `kind=extractive` 的回答摘录、产物和检查索引，四组语义结论留空。不会把截取回答冒充语义摘要。最终回答另有 answer hash，摘要带 sourceMessageCount、sourceHash、更新时间；最近 5 个被替换版本保存在任务快照的 summaryHistory。

摘要只覆盖生成它之前已完成的轮次，不覆盖自己的未完成工具调用。证据改变后摘要失效，最终阶段可回退到提取式摘要。`record_summary` 结果通过原有工具回执恢复，避免崩溃后丢失已保存摘要。

上下文默认 80,000 字符，可配置 `context.maxCharacters`（4,000～200,000）。超过预算的 60% 时提示模型提前整理摘要；压缩保留初始指令、目标、选中 Skill、交接包及近期完整 assistant/tool 轮次。有效摘要只能替代它实际覆盖的历史，新观测不能被旧摘要吞掉。无摘要时仍可归档旧轮次并保留明确标注的产物索引，完整消息始终留在检查点。固定输入、交接、未覆盖轮次或最新轮次仍超限时返回 `CONTEXT_LIMIT`；字符预算不是 tokenizer 的精确 Token 预算。

## 本地 Skill

配置注册 ID 与工作区相对路径，任务显式选择；不会自动扫描或把全部正文塞给模型：

```json
{
  "version": 1,
  "skills": { "doc-style": { "path": "skills/doc-style/SKILL.md" } },
  "context": { "maxCharacters": 80000 }
}
```

```bash
node bin/taskweave.mjs run --kind document --prompt "生成说明" \
  --workspace work/v04-001 --skill doc-style
```

`--skill` 可重复，最多 3 个。工作流在节点定义写 `"skills": ["doc-style"]`。子任务不会隐式继承父任务 Skill；恢复时不能重新选择 Skill。`skills list/show` 读取用户明确请求的目录项；执行器只读取本任务选中的正文。

SKILL.md 必须有 name、description、version 三个单行 frontmatter 字段，name 匹配注册 ID；正文非空。这里采用受限的 Markdown 元数据格式，不支持通用 YAML、多行字段、额外工具或脚本声明。注册最多 30 项，每个文件最多 12,000 字符，所选正文合计最多 24,000 字符。

任务保存 id、description、version、path、sha256。文件或版本改变后 `SKILL_CHANGED` 阻止继续执行或验收；恢复原文件可继续，采用新版需创建新任务/attempt。模型不能写已注册 Skill 文件，也不能因 Skill 获取额外命令或工具权限。Skill 与交接均以有明确来源的任务资料进入上下文，不进入系统消息。

## 验证效果

自动化用模拟 Provider 验证协议、证据校验、压缩与恢复，不宣称真实模型成功率或 Token 降幅。真实效果应在固定模型、相同输入、相同人工验收标准下比较独立工作区运行：

1. 保留原固定用例作为基线，在新工作区启用 v0.4；不要在同一 attempt 改配置或 Skill。
2. 保存 `workflow report <run-id> --json` 的总 Token、执行耗时、人工等待和介入次数，同时检查 `summary` 中的来源与摘要类型。
3. 记录检查通过率及人工评审结论，区分模型摘要与提取式回退；多次运行再判断效果。

尚不包含向量检索、长期记忆、Skill 自动推荐、MCP、产物快照隔离或 Web 工作台。
