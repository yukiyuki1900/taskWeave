# 后续规划

当前 v0.4 已实现本地任务与工作流、目录边界、结构化上下文交接、带证据的任务摘要和显式本地 Skill。下一版本 v0.5 计划完成 Web 展示、完整 Demo 与开源发布材料；目前已实现 MR 1 的本地只读查询 Server，UI 尚未实现。

| 阶段 | 工作 | 归属与完成条件 |
| --- | --- | --- |
| 目录整理 | CLI + contracts/core/adapters/evaluation；规则提取；依赖约束 | 原有命令、数据与恢复语义兼容，核心可用内存实现运行 |
| v0.4 已实现 | 结构化交接、带证据摘要、显式本地 Skill、只读摘要查询 | core/agent、core/workflow、core/skills；模拟模型覆盖恢复、证据与工具边界 |
| 效果验证待完成 | 固定真实模型基线、失败归因、Token 与人工评审对比 | evaluation；不能仅凭自动化通过断言模型效果提升 |
| 产物与工作区 | attempt 产物版本、独立目录或 worktree、返工后文件处理 | core/artifacts、adapters/workspace；证明旧产物不会污染新执行 |
| 工具扩展 | 工具注册演进、Skill 自动发现或推荐、MCP 适配 | core/tools 与 adapters；每个副作用工具有权限和恢复策略 |
| 服务化 | API 与执行进程分离、控制协议、事件恢复 | apps/server、apps/agent-runtime；管理端拥有当前 attempt，Runtime 上报检查点与结果 |
| v0.5 MR 1 已实现 | HTTP 展示协议、本地只读 API、状态/报告/事件/产物查询 | apps/server、contracts/http；读取不改状态，hash 不匹配不返回历史文件内容 |
| v0.5 Web 与开源展示 | 任务与工作流状态、执行过程、产物与人工验收 | apps/web；UI 调用 API，避免直接依赖 core 或 adapters；补齐可复现 Demo、截图、发布说明和贡献指南 |
| 按需扩容 | 并行隔离、任务认领、心跳、租约、fencing、独立连接层 | 在单进程语义与产物隔离稳定后实施；Gateway 有独立连接需求时引入 |

当前继续使用本地工作区排他锁与文件存储。未来新增数据库或消息队列时，应围绕实际一致性和所有权设计接口，不能将本地锁改名后当作分布式租约使用。
