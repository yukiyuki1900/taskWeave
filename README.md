# TaskWeave · 织程

**把目标织成任务，把任务落成产物。**

TaskWeave 是用 TypeScript 实现的任务型 Agent。需求分析、测试设计、文档生成和代码修改共享 Agent Loop、工具、检查点和独立验收机制。

当前版本 **v0.3.0-alpha.1**，面向本地单用户 CLI。支持固定工作流、节点依赖、串行调度、人工验收、返工传播和中断恢复。每个节点复用统一 Agent Loop，模型最终回答后独立检查产物和配置规则。

## 快速体验

需要 Node.js **20.19+** 和 npm，无需构建或启动服务。

```bash
npm ci
npm run demo
```

离线演示生成需求文档和两个待执行子任务，父任务进入 `waiting_acceptance`。`--demo` 使用固定脚本，不调用模型，不代表模型推理效果。

```bash
npm start -- list --workspace .demo
npm start -- show <task-id> --workspace .demo
npm start -- accept <task-id> --workspace .demo --note "已核对范围和验收标准"
# 或退回；随后显式恢复，让模型根据验收意见修改
npm start -- reject <task-id> --workspace .demo --note "请补充权限异常场景"
npm start -- resume <task-id> --workspace .demo --demo
```

`accept` / `reject` 二选一。离线脚本不会理解和修复验收意见；修正能力需用真实模型验证。普通 `create_task` 子任务仍需单独 `resume`；需要依赖编排时使用工作流。

## 工作流

```bash
npm run workflow:demo
npm start -- workflow show <run-id> --workspace .demo/workflow --json
npm start -- workflow accept <run-id> --workspace .demo/workflow \
  --node requirements --attempt <attempt-id> --note "已核对需求模板" --demo
```

演示按需求、实现、测试、文档顺序执行，每个节点等待人工验收，接受后自动启动下游。`attemptId` 从运行输出获取，每次重试或返工后改变；旧执行不能继续更新当前节点或通过文件工具写入。

真实模型示例和用户验证配置位于 `examples/workflows/`。工作流支持依赖环检查、失败显式重试、传递下游过期标记、取消恢复、状态及事件查询。详见 [工作流使用与恢复](docs/guides/workflows.md)。

## 接入真实模型

复制 `.env.example` 为 `.env`，填写支持 function tools 的 Chat Completions API 根地址、模型和密钥。CLI 不自动读取环境文件。

```bash
node --env-file=.env bin/taskweave.mjs run \
  --kind requirements \
  --prompt "读取 brief.md，整理用户故事、业务规则和验收标准，生成需求文档" \
  --workspace work
```

程序在 `TASKWEAVE_BASE_URL` 后追加 `/chat/completions`。密钥只从进程环境读取，不写入快照。工作区文件片段会发送给所配置的模型服务，请选择适合这些资料的服务。

当前自动化验证覆盖脚本 Provider 和模拟 HTTP 协议。**本次发布未配置真实模型密钥，尚未取得真实模型基线结果。** 不同服务仍需分别验证兼容性。

## 任务与工具

| 类型 | 主要交付 |
| --- | --- |
| `requirements` | 需求文档、验收标准、开发与测试子任务 |
| `tests` | 测试计划、测试代码，配置后可执行验证 |
| `document` | README、设计说明、接口文档 |
| `code` | 文本文件修改、验证结果与变更说明 |
| `general` | 其他文件与任务交付 |

模型使用 `list_files`、`read_file`、`search_files`、`write_file`、`create_task`、`ask_user`。配置验证命令后，额外开放 `run_checks`，只接受命令名称，不能指定命令、参数或环境变量。

`write_file` 使用预期 SHA-256 检查冲突并原子替换文件。独立检查会确认已记录产物仍与生成时的 hash 一致。

## 独立验证与人工验收

```text
生成 → validating → 检查失败 → validation_failed → resume 修正
                 ↘ 检查通过 → waiting_acceptance → accept → completed
                                                   ↘ reject → validation_failed
```

默认策略需要人工验收。显式配置至少一项文件规则或命令检查，并设置 `requireApproval: false`，才允许检查通过后直接完成。

支持普通文本文件存在、包含指定文本、JSON 顶层必需字段三类规则，以及用户配置的命令检查。结构检查只能证明相应规则通过，不能替代业务正确性判断。`accept` 会重新运行检查并核对产物，避免使用过期证据；验收备注必须非空。

```bash
# 在工作区初始化后，由用户维护隐藏配置，文件工具不能改它
mkdir -p work/.taskweave
cp examples/taskweave.config.json work/.taskweave/config.json
# 按项目修改命令及规则后再创建任务
npm start -- run --kind code --prompt "修复业务逻辑并验证" --workspace work
npm start -- validate <task-id> --workspace work
```

示例配置中的测试文件和产物路径需要按项目调整。创建任务时绑定配置指纹；恢复、验证和验收必须使用相同配置，防止静默切换命令。详见 [验证配置与命令边界](docs/guides/validation.md)。

## 评测

```bash
# 四类任务的固定脚本冒烟检查，不需要 Key
npm run eval:demo
# 20 个真实模型任务，支持只执行前 N 个；显式加载环境配置
node --env-file=.env bin/taskweave.mjs eval \
  --suite examples/evaluation/baseline.json --workspace .cache/evaluations --limit 4
```

每轮创建独立目录，每个用例使用独立工作区，逐例保存 `report.json`。报告包含检查通过率、状态、耗时、Token、模型/工具调用和需要人工介入的次数。默认不换算金额。

基线包含需求、测试设计、文档、代码各 5 例。文档类主要检查结构，代码类执行固定断言；**检查通过率不是未经限定的业务成功率**。详见 [评测说明](docs/guides/evaluation.md)。

## CLI

```text
run       --prompt <目标> [--kind general] [--demo]
resume    <任务ID> [--answer <回答>] [--demo]
validate  <任务ID>
accept    <任务ID> --note <验收依据>
reject    <任务ID> --note <返工原因>
list
show      <任务ID>
events    <任务ID> [--after <序号>]
unlock
eval      --suite <评测集> [--demo] [--limit N]
```

常用参数：`--workspace`、`--json`；执行类支持 `--timeout`，模型执行类支持 `--max-steps`。验证配置默认读取工作区的 `.taskweave/config.json`，也可显式 `--config <工作区相对路径>`。查看 `npm start -- --help`。

- 默认累计模型调用上限 24，最大 200；失败请求也计步，恢复时可以提高。
- 单次运行时限默认 300 秒，最大 1 小时。命令另有时限，默认 30 秒、最大 120 秒。
- `ask_user` 持久化问题，`resume --answer` 后继续未完成工具批次。
- Ctrl+C 取消执行并保留检查点。工作区排他锁保证本工具的写入串行化。
- `completed`、`waiting_input`、`waiting_acceptance` 的退出码为 0；验证失败、错误或预算耗尽为 1；取消为 130。自动化调用应检查 JSON `status`。
- 已完成任务不重复执行；配置与模型标识在恢复时必须匹配。

## 恢复与限制

状态存于工作区 `.taskweave/`：任务快照、JSONL 事件、工具回执和命令执行记录。已保存回执的工具不重复执行；文件更新通过目标 hash、子任务通过稳定 ID 处理常见恢复窗口。

验证命令在启动前记录 `started`。若进程崩溃后没有完成记录，恢复返回 `unknown`，不会自动重复命令。用户核实副作用后可显式发起新一轮 `validate`。不提供通用 exactly-once 保证。

- 文件路径检查拒绝父目录、隐藏路径、凭据后缀、依赖目录及符号链接；**不是操作系统沙箱**。
- 验证命令虽不使用 Shell、只接受固定参数，仍以当前用户权限执行，包括它读取或运行的模型生成代码。命令能访问哪些文件和网络由宿主权限决定；仅用于可信本地项目。
- 子进程不继承模型密钥或完整环境；保留 PATH 等少数基础变量。命令输出会保存并可能发送给模型，不应输出敏感资料。
- 上下文按字符预算保留目标、近期完整工具轮次及产物索引；没有语义摘要、向量检索或长期记忆。
- 支持固定 DAG 的串行调度；没有并行多 Agent、分布式 Worker、Web UI、MCP 或 Git 自动提交。节点共享工作区，返工会标记旧结果过期，但不回滚文件；当前不提供产物快照隔离。
- v0.1 快照仍可读取；已完成的旧任务不会被追溯标成“已验收”。未完成旧任务首次恢复时绑定 v0.2 配置，并采用新验收流程。

## 开发

```bash
npm ci --include=dev
npm test
npm run typecheck
npm run check:boundaries
```

仓库使用 npm workspaces，安装和执行命令统一在仓库根目录进行，无需构建或启动服务。

```text
apps/cli/             命令入口、参数解析、结果展示、依赖组装
packages/contracts/   任务、工作流、事件、产物与验收协议
packages/core/        任务、工作流、Agent Loop、工具、验证与能力接口
packages/adapters/    模型 HTTP、本地文件、持久化和子进程实现
packages/evaluation/  独立评测执行与报告
packages/core/test/   使用内存实现验证核心能力的单元测试
tests/integration/    文件、命令、恢复和跨模块集成测试
tests/e2e/            CLI 命令与完整工作流测试
```

从 [Agent Loop](packages/core/src/agent/engine.ts) 开始阅读，再看 [工作流编排](packages/core/src/workflow/engine.ts)、[能力接口](packages/core/src/ports/index.ts) 和 [本地依赖组装](packages/adapters/src/runtime.ts)。包之间使用 `@taskweave/*` 公开入口，核心包通过接口使用基础设施。

本次目录调整保持原有 CLI、`node --env-file=.env bin/taskweave.mjs` 入口及 `.taskweave/` v1 数据编码。TypeScript 调用方需要改用 workspace 包入口并显式注入 `localServices`，详见 [模块边界与迁移](docs/architecture/module-boundaries.md)。Server、独立 Runtime 和 Web 的引入条件见 [后续规划](docs/roadmap.md)。

[架构与故障恢复](docs/architecture.md) · [任务示例](examples/tasks/use-cases.md) · [贡献说明](CONTRIBUTING.md) · [版本记录](CHANGELOG.md)

## License

[MIT](LICENSE)
