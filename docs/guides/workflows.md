# 工作流（v0.3+）

工作流定义固定节点及依赖，由本地调度器串行执行就绪节点。节点复用 v0.2 TaskEngine、独立验证与人工验收。没有后台服务、分布式 Worker 或并行执行。

## 无密钥体验

```bash
npm ci
npm run workflow:demo
npm start -- workflow show <run-id> --workspace .demo/workflow --json
```

演示按“需求 → 实现 → 测试 → 文档”执行，四个节点都需要人工验收。每次从输出找到等待节点的 `attemptId`：

```bash
npm start -- workflow accept <run-id> --workspace .demo/workflow \
  --node requirements --attempt <attempt-id> --note "已核对需求模板" --demo
```

接受后自动执行下一个就绪节点，再次等待验收。依次接受 implementation、tests、documentation；每个节点使用自己的 attempt ID。固定脚本只验证流程，不会理解需求、修复业务或证明真实模型质量。工作流模式不创建额外子任务。

## 真实模型示例

`examples/workflows/delivery.json` 展示标题规范化需求、实现、测试与文档交付。模型需要支持 function tools。先由用户配置可信验证命令：

```bash
mkdir -p work/.taskweave
cp examples/workflows/config.json work/.taskweave/config.json
node --env-file=.env bin/taskweave.mjs workflow run \
  --file examples/workflows/delivery.json --workspace work
```

需求通过文件字段检查后等待人工确认；接受后自动实现、验证、编写并运行测试，最后等待文档验收。按真实结果检查产物；本版本没有配置真实模型密钥做端到端验证，示例是可运行入口，不是效果承诺。

### 模型请求失败排查

终端会显示当前失败节点的原因；`workflow show <run-id> --workspace work --json` 可查看当前 attempt 的 `error`，普通 `show <task-id> --workspace work --json` 可查看任务使用的 provider、步数与用量。`steps` 在请求前递增，不能直接当作成功响应次数。

HTTP 400 表示请求被模型服务拒绝，增加 `--timeout` 无法解决。适配器只读取最多 16 KiB 的错误 JSON，将可识别的 `reasoning_content`、工具调用历史、输出长度或思考参数问题转换为固定提示，不回显服务端原文；未知错误保留通用 HTTP 状态。提示用于缩小排查范围，不证明唯一原因。

工具结果必须对应历史 assistant 消息中保留的 `tool_calls`。旧版本曾因待执行队列与历史共用数组，在消费队列时删掉历史调用；修复后两者分离。若旧运行的调用记录已丢失，更新代码后使用 `workflow retry` 再 `workflow resume` 创建新尝试，不直接恢复损坏的历史。retry 不会删除旧文件，新尝试仍须核对文件及其 hash。

对于 DeepSeek 思考模式的工具调用，需按[官方说明](https://api-docs.deepseek.com/guides/thinking_mode/)回传模型返回的 `reasoning_content`。执行器保留该字段的原值，包括空字符串和 null；模型未返回该字段时不会补造内容。修复前的旧检查点可能已经丢失字段，失败节点应使用下文的 `workflow retry`，再 `workflow resume` 创建新尝试；单独 resume 不会重跑失败节点。

## 定义与校验

```json
{
  "version": 1,
  "name": "文档交付",
  "nodes": [
    {
      "id": "requirements",
      "kind": "requirements",
      "goal": "将需求写入 artifacts/spec.json，包含 scope、acceptance",
      "validationPolicy": {
        "rules": [{ "type": "json_fields", "path": "artifacts/spec.json", "fields": ["scope", "acceptance"] }],
        "requireApproval": true
      }
    },
    {
      "id": "docs",
      "kind": "document",
      "goal": "依据已验收需求生成 README.md",
      "dependsOn": ["requirements"]
    }
  ]
}
```

最多 30 个节点；节点 ID 唯一，只允许字母开头的字母、数字、下划线和连字符。定义拒绝不存在、自引用、重复和循环依赖。节点可配置 title、acceptanceCriteria、validationPolicy、maxSteps；验收命令必须事先出现在用户配置中。

`--file` 基于命令当前目录，配置默认读取工作区 `.taskweave/config.json`。定义固化在运行快照中；编辑源 JSON 不会修改已有运行。配置指纹在恢复、验收、回答和返工前核对。

## 标识与状态

| 标识 | 含义 |
| --- | --- |
| `runId` | 一次完整工作流 |
| `nodeId` | 定义中的逻辑节点 |
| `attemptId` | 一个节点的一次执行尝试 |
| `taskId` | 该次尝试对应的 TaskEngine 任务，由前三个 ID 稳定推导 |

节点状态为 blocked、ready、running、waiting_input、waiting_acceptance、succeeded、failed、cancelled。attempt 额外支持 invalidated。运行状态汇总为 pending、running、waiting_input、waiting_acceptance、failed、cancelled、completed。

只有直接依赖全部 succeeded 才能启动节点；succeeded 要求任务具有有效验证及所需人工验收。多个独立节点按定义顺序串行调度；某节点等待用户时，可执行其他无依赖关系的就绪节点。发生执行失败时停止后续调度，不自动重试。

只有当前 attempt 的任务结果可以更新节点。任务还记录直接依赖的 attempt ID；依赖版本变化时拒绝结果。普通任务命令不能直接 resume、validate 或 accept 工作流任务，必须走工作流入口。工具执行前再次核对任务归属，防止过期任务继续通过本工具写文件。

## 输入、验收与返工

```bash
npm start -- workflow answer <run-id> --workspace work \
  --node <node-id> --attempt <attempt-id> --answer "补充信息"
npm start -- workflow accept <run-id> --workspace work \
  --node <node-id> --attempt <attempt-id> --note "验收依据"
npm start -- workflow reject <run-id> --workspace work \
  --node <node-id> --attempt <attempt-id> --note "请补充异常流程"
```

answer / accept 成功后会继续调度，需要原模型配置；离线任务加 `--demo`。accept 复用独立验收器，重新检查文件与命令。reject 使本次节点执行失败并停止释放下游。

```bash
# 失败重试；只适用于失败或取消的节点
npm start -- workflow retry <run-id> --workspace work \
  --node <node-id> --attempt <attempt-id> --note "根据失败原因重试"
# 任意已启动节点返工，包括已完成节点
npm start -- workflow rework <run-id> --workspace work \
  --node <node-id> --attempt <attempt-id> --note "需求范围调整"
npm start -- workflow resume <run-id> --workspace work
```

retry / rework 先标记目标节点及所有传递下游的当前 attempt 为 invalidated，清空这些节点的当前引用，保留历史与原因；无关分支保持有效。之后 resume 为就绪节点创建新 attempt、新 task 和新的回执命名空间，每节点最多 50 次尝试。

返工不删除、回滚或自动合并原有文件。旧产物在历史记录中过期，但仍可能保留于工作区；v0.4 新建下游节点接收绑定来源 task/attempt、验证 ID 和产物 hash 的结构化交接；直接交接文件在该 attempt 中只读，修改上游需显式返工。旧任务保留原有目标和输入表示。这是串行共享工作区模型，不提供产物快照隔离、Git worktree 合并或任意外部进程写入的防护。

## 检查点与恢复

运行记录与事件存于 `.taskweave/workflows/<run-id>.json` / `.jsonl`，任务、回执与命令记录复用 v0.2 目录。快照是恢复依据，事件不用于独立重建全部状态。

| 中断位置 | 恢复行为 |
| --- | --- |
| attempt 保存、Task 尚未创建 | 按稳定 task ID 创建同一个任务，不新增 attempt |
| Task 运行中退出 | 继续现有 Task 检查点，复用工具与命令回执 |
| Task 完成、节点状态未更新 | 读取已保存结果推进节点，不再请求模型 |
| 人工接受已保存、节点尚未更新 | 从 Task 的验收记录恢复并释放依赖 |
| 回答已保存、尚未传给 Task | 使用已保存待回答内容，已插入的回答不会重复插入 |
| 命令执行结果未知 | 沿用 v0.2 unknown 语义，节点失败，核实后显式 retry |
| Ctrl+C 取消 | 保存取消状态，resume 继续同一 attempt；retry 才创建新尝试 |

工作流运行、验收、返工及工具执行共用工作区排他锁。强制退出后的遗留锁需确认旧进程已退出，再执行 `taskweave unlock --workspace work`。第二个执行器不能抢占存活执行器的锁。

该机制面向同一机器的本地恢复，不是分布式租约或 fencing token。验证命令仍以宿主用户权限执行，非操作系统沙箱；断电持久性、外部副作用和托管子进程的边界见 [架构](../architecture.md) 与 [验证说明](validation.md)。

## 其他命令与退出码

### 运行报告

```bash
node bin/taskweave.mjs workflow report <run-id> --workspace work
node bin/taskweave.mjs workflow report <run-id> --workspace work --json
```

report 读取已有 v1 快照及事件，不需要模型密钥和验证配置，不调用模型、运行检查、验收、恢复或写入工作区；不存在的工作区会报错，不会创建目录。旧运行可以直接查看，不需要重新执行。默认输出终端摘要，`--json` 输出完整报告，可用 shell 重定向保存。

| 报告字段 | 统计口径 |
| --- | --- |
| `status` / `summary.succeededNodes` | 本次运行状态和当前成功节点数；单次报告不计算跨运行成功率 |
| `summary.current` | 只汇总各节点当前 attempt 的 Token、模型轮次及工具次数 |
| `summary.total` | 汇总本运行所有 attempt，包括失败和已失效的尝试；不包含工作区中的其他运行 |
| `summary.human.requests` | 工作流节点请求输入或验收的事件数；验收时重跑检查产生的任务等待事件不重复计数 |
| `summary.human.actions` | 用户提交回答、接受、退回、重试和返工的事件数；接受操作不等于该次重新检查通过 |
| `summary.timing.elapsedMs` | 从工作流创建到本轮完成/失败/取消事件；未停止的运行计至报告生成时间 |
| `summary.timing.executionMs` | 根据任务启动、验证及终止事件计算的已记录执行区间并集，包含模型、工具、验证；不等于模型推理耗时 |
| `summary.timing.humanWaitMs` | 任务等待输入/验收至回答、重新验证、接受或失效的区间并集，排除与其他节点执行重叠的时间 |
| `summary.timing.unattributedMs` | 总时间中未归入以上两项的部分，包含调度开销、暂停和未观测间隔；三项相加等于总时间 |
| `nodes[].attempts[]` | 各次尝试的 ID、当前/历史标记、任务状态、Provider、错误、用量及时间 |
| `warnings` / `summary.dataComplete` | 缺失、损坏或归属不匹配的记录会明确提示，用量只累计可读取部分 |
| `summary.timing.complete` | 无闭合终止事件或时间记录不完整时为 false；开放执行段只计至最后事件，不把崩溃后的时间推定为执行时间 |

模型轮次包含失败请求；适配器内部 HTTP 重试不单独计数。Token 仅累计服务端已返回的 usage，缺少 usage 时的 0 不意味着没有费用；报告不估算金额。工具次数来自工具开始/失败事件，可能包含恢复回放，不包含独立验证命令。运行中读取为尽力而为的观测，不是跨文件原子快照；完整运行后查看更适合比较。

`workflow create --file` 只保存定义，不调用模型。`list`、`show`、`events --after N` 不需要模型密钥。`--json` 输出完整状态，进度写入 stderr。

`--timeout` 限制整次 CLI 操作，默认 300 秒、最大 3600 秒。`--max-steps` 是每个节点任务的累计模型调用上限，1 到 200，不是整个工作流的总 Token 预算。单次调用退出后没有后台调度器；等待、返工后用对应操作或 resume 继续。

退出码 0 表示命令成功，包括等待输入和等待验收；失败为 1，取消为 130。自动化调用同时检查 JSON 中的 status。

## v0.4 的交接与 Skill

节点定义可用 `"skills": ["doc-style"]` 显式选择配置中注册的本地 Skill。`summary <task-id> --json` 查看节点任务的带证据摘要、交接和 Skill 绑定；执行与验收会校验版本及来源。操作步骤、只读输入限制和完整示例见 [上下文与 Skill](context-and-skills.md)。
