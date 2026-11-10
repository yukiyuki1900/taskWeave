# 后续规划

当前 v0.4 已实现本地任务与工作流、目录边界、结构化上下文交接、带证据的任务摘要和显式本地 Skill。v0.5.0-alpha.1 已实现只读 Server、Web 工作台、静态 Demo、回放与发布材料；当前为源码候选，真实模型基线、外部公开发布和部署仍待完成。

| 阶段 | 工作 | 归属与完成条件 |
| --- | --- | --- |
| 目录整理 | CLI + contracts/core/adapters/evaluation；规则提取；依赖约束 | 原有命令、数据与恢复语义兼容，核心可用内存实现运行 |
| v0.4 已实现 | 结构化交接、带证据摘要、显式本地 Skill、只读摘要查询 | core/agent、core/workflow、core/skills；模拟模型覆盖恢复、证据与工具边界 |
| 效果验证待完成 | 固定真实模型基线、失败归因、Token 与人工评审对比 | evaluation；不能仅凭自动化通过断言模型效果提升 |
| 产物与工作区 | attempt 产物版本、独立目录或 worktree、返工后文件处理 | core/artifacts、adapters/workspace；证明旧产物不会污染新执行 |
| 工具扩展 | 工具注册演进、Skill 自动发现或推荐、MCP 适配 | core/tools 与 adapters；每个副作用工具有权限和恢复策略 |
| 服务化 | API 与执行进程分离、控制协议、事件恢复 | apps/server、apps/agent-runtime；管理端拥有当前 attempt，Runtime 上报检查点与结果 |
| v0.5 MR 1 已实现 | HTTP 展示协议、本地只读 API、状态/报告/事件/产物查询 | apps/server、contracts/http；读取不改状态，hash 不匹配不返回历史文件内容 |
| v0.5 MR 2 已实现 | 列表、DAG、attempt 历史、运行指标、产物、验收、摘要交接、Skill 与事件 | apps/web 只依赖展示协议；apps/server 同源托管；验收和执行仍用 CLI |
| v0.5 MR 3 已实现 | 12 阶段 API 录制、静态回放、完整 Demo、真实截图/录屏和源码归档 | 固定脚本实际运行引擎，明确来源；不自动公开发布或部署 |
| 开源发布待执行 | 核对源码包、选定公开仓库、创建发布与部署入口 | 按 docs/open-source.md；不携带个人工作区与 Git 历史 |
| 按需扩容 | 并行隔离、任务认领、心跳、租约、fencing、独立连接层 | 在单进程语义与产物隔离稳定后实施；Gateway 有独立连接需求时引入 |

当前继续使用本地工作区排他锁与文件存储。未来新增数据库或消息队列时，应围绕实际一致性和所有权设计接口，不能将本地锁改名后当作分布式租约使用。
