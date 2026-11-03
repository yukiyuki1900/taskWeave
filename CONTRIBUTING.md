# 贡献说明

使用 Node.js 20.19+。在根目录执行 `npm ci --include=dev` 后，可运行 `npm test`、`npm run typecheck` 和 `npm run check:boundaries`。项目以 TypeScript ESM 组织，内部 import 使用 `.ts` 后缀，通过 `tsx` 直接运行，无需构建或启动端口。

## 修改原则

- 各任务类型共享同一个执行循环，不复制一套专用内核。
- 工具 schema 是模型的使用说明；运行时还必须独立检查必填字段、未知字段、类型和资源上限。
- 新增副作用工具时，写明权限和中断重放策略；不要假设本地回执等同于远端事务。
- 模型请求与工具执行都要响应取消信号；不要把错误吞掉并伪装成成功。
- 产物、CLI 和 README 必须区分真实执行、固定演示和未经验证的结果。
- 不将模型密钥、`.env`、任务快照、生成产物、依赖目录或个人资料提交到仓库。

## 目录与依赖

- 应用入口放 `apps/`；本地 CLI 的参数与输出归 `apps/cli`。
- 业务规则放 `packages/core`，按 task、workflow、agent、tools、validation 等职责归位。
- 模型、文件系统、存储与子进程实现放 `packages/adapters`；core 只依赖接口。
- 跨边界序列化协议放 `packages/contracts`；内部检查点、模型消息与配置类型保留在 core。
- `packages/evaluation` 可以组合 core 和 adapters，运行时不能反向依赖评测。
- 跨包引用必须通过各自 package.json 的 exports；不要用相对路径访问另一个包。
- 新增基础设施能力先确认现有 ports 是否足够，再扩展接口和实现。
- 单元测试放所属包的 `test/`，跨模块测试放 `tests/integration/`，CLI 测试放 `tests/e2e/`。
- 目录搬迁同步更新架构文档、阅读入口与脚本。详见 [模块边界](docs/architecture/module-boundaries.md)。

## 测试组织

`tests/integration/engine.test.ts` 验证完整工具循环、人工补充输入、恢复与预算；`tools-store.test.ts` 验证内容冲突、路径和存储行为；`provider-context.test.ts` 使用注入的 fetch 验证协议与上下文，不连接真实模型；`cli.test.ts` 验证 CLI 与离线任务类型。

`validation.test.ts` 验证生成与验收分离、返工、外部文件变化和配置绑定；`checks.test.ts` 实际运行短命令验证超时、取消、输出上限和未知结果；`evaluation.test.ts` 验证用例隔离、指标口径和基线检查器。命令检查的执行边界和恢复语义有变更时，需同步更新这些测试与验证文档。

`tests/integration/workflow.test.ts` 和 `tests/e2e/workflow-cli.test.ts` 覆盖依赖校验、串行调度、人工验收、attempt 隔离、传递失效及恢复窗口。新增工作流控制动作必须校验当前 attempt，并与工具写入共用工作区锁。

测试只在当前目录的 `.cache/` 下创建临时资料，并在结束后清理，不启动网络监听服务。提交 PR 时说明实际运行的检查、结果和未覆盖的外部依赖。

`packages/core/test/runtime.test.ts` 仅注入内存存储、工作区与命令实现，验证核心无文件系统依赖，并覆盖验收、attempt 过期和命令未知结果的顺序。`scripts/check-boundaries.mjs` 使用 TypeScript AST 检查包依赖、公开入口及 core 的基础设施导入；这是仓库维护检查，不是操作系统沙箱。
