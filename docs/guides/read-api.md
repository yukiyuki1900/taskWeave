# v0.5 MR 1：本地只读查询 API

本指南介绍 HTTP 展示协议与 API-only Server。任务执行、回答、验收和返工仍由 CLI 完成，没有这些操作的 HTTP 路由。MR 2 已增加可选 Web 托管，详见 [Web 指南](web.md)；省略 --web 时仅提供以下 API。

## 启动

需要现有的 Node.js 20.19+ 环境和已初始化的 TaskWeave 工作区。在仓库根目录安装依赖，然后在自己的开发机启动：

```bash
npm ci
npm run server -- --workspace work/e2e-001 --port 4310 --name TaskWeave
```

工作区可以是之前 CLI 生成的目录，不需要重新运行工作流，也不需要模型密钥或加载 `.env`。Server 不创建工作区或状态目录，不解析模型及验证配置。不存在或未初始化的工作区会启动失败。

Server 只监听 `127.0.0.1`，地址为 `http://127.0.0.1:4310`；使用该地址访问，Host 和 Origin 必须匹配。没有跨域 CORS 接口或远程访问开关；本阶段面向本地单用户查询。Ctrl+C 关闭 Server，不取消另一个进程中运行的 CLI。

```bash
curl http://127.0.0.1:4310/api/v1/workspace
curl 'http://127.0.0.1:4310/api/v1/workflows?limit=20'
curl 'http://127.0.0.1:4310/api/v1/tasks?scope=all'
curl http://127.0.0.1:4310/api/v1/workflows/<run-id>
curl http://127.0.0.1:4310/api/v1/workflows/<run-id>/report
curl http://127.0.0.1:4310/api/v1/tasks/<task-id>
curl 'http://127.0.0.1:4310/api/v1/events?scope=task&id=<task-id>&after=0&limit=100'
```

以上 `<...>` 需替换为实际 ID。所有接口仅允许 GET；POST、PUT、PATCH、DELETE、HEAD、OPTIONS 返回 405。查询参数采用白名单，未知、重复、非法筛选或超限值返回 400。业务 ID 与路径参数严格校验，浏览器不能传入磁盘路径或切换工作区。

## 响应协议

成功响应统一包装：

```json
{
  "apiVersion": 1,
  "observedAt": "2026-11-03T09:00:00.000Z",
  "revision": { "workflows": {}, "tasks": {} },
  "warnings": [],
  "data": {}
}
```

`revision` 记录本次查询读取的工作流、任务序号。运行内部的工具调用会推进 Task 序号，工作流序号可能尚未变化；前端应分别比较。Server 每次请求重新读取，只在单次请求中复用同一对象的快照，不跨请求缓存状态。

这是跨多个文件的观察，不是数据库事务。可能先读到工作流快照、再读到更新后的任务；保留各自序号和观察时间。缺失的关联任务会在工作流详情显示 warnings，报告保留可读取统计并标记 dataComplete=false，不会伪装为完整零消耗。状态或事件暂不可读取时可以重新查询。

错误响应为 `{ "apiVersion": 1, "observedAt": "...", "error": { "code": "...", "message": "...", "details": {} } }`。不回显原始文件系统错误或堆栈。响应均为 JSON，设置 no-store、nosniff 和 same-origin 资源策略。

## 查询接口

| 路由 | 参数 / 内容 |
| --- | --- |
| `/api/v1/workspace` | 展示名称、本地只读模式、可用查询能力；不返回工作区绝对路径 |
| `/api/v1/workflows` | `status`、`limit`、`cursor`；按创建时间倒序、ID 升序分页 |
| `/api/v1/workflows/:runId` | 工作流定义的节点与依赖、持久化状态、attempt 历史、当前 Task 状态与序号 |
| `/api/v1/workflows/:runId/report` | 复用 CLI 报告的统计算法，保留当前/历史消耗、执行/人工等待/未归属时间和完整性提示 |
| `/api/v1/tasks` | `status`、`limit`、`cursor`、`scope=standalone\|all`；默认 standalone，包含无 workflow 归属的父任务及子任务 |
| `/api/v1/tasks/:taskId` | 目标、结果、待回答问题、产物索引、独立验证、人工意见、摘要、交接和 Skill 绑定 |
| `/api/v1/tasks/:taskId/artifacts/:artifactId` | 读取该 Task 已登记且 hash 仍匹配的文本产物 |
| `/api/v1/events` | `scope=task\|workflow`、`id`、`after`、`limit`；事件序号只在其所属对象内有效 |

列表默认 limit=20，最大 100；事件默认 100，最大 200。列表返回 `{items,nextCursor}`，末页 nextCursor=null。游标绑定集合、状态与 scope；改变筛选条件后必须从首屏查询。分页期间插入较新的运行，不会让后续页重复之前的记录；回到首屏获取新运行。

事件返回 `{items,nextAfter,hasMore,snapshotSeq,complete}`。只返回序号不超过本次快照的完整日志行，忽略未提交尾片段，不修复或重写日志。after 超过当前快照返回 409/CURSOR_AHEAD。缺口、重复或归属异常标记 complete=false 并附 warnings；发现不完整时间线后应提示用户，而不是据此推断运行成功。

任务 answer 最多返回 20,000 字符预览；answerTruncated=true 时需提示内容未完整展示，完整回答仍在本地检查点。

事件 data 只投影节点、attempt、任务、工具调用、验证、错误码等标识及少量计数/布尔字段。不会直接返回问答正文、完整 observation、stdout/stderr 或未知字段。任务的结果、问题和人工备注是明确展示的业务内容，仍可能含用户自行写入的资料；这不是通用内容脱敏服务。

## 产物与历史 attempt

Task 响应的 artifacts 提供稳定 artifactId（绑定 taskId、路径和记录 hash）。客户端从该列表获取 ID；接口不接受任意文件路径，也不提供目录浏览。

匹配时返回记录 hash、当前 hash、文本内容及格式。Markdown 标记为 markdown，JSON 为 json，其余（包括 HTML）为 text；响应始终是 JSON，不执行文件内容。historicalContent=false 表示内容取自当前文件，不来自版本快照。

- 当前 hash 不匹配：409/ARTIFACT_CHANGED，仅返回两个 hash，不返回变化后的内容，不能冒充旧 attempt 的文件版本。
- 文件消失：404/ARTIFACT_MISSING。
- 未登记的产物 ID：404/NOT_FOUND。
- 链接、隐藏路径、父目录、凭据后缀或依赖目录：403/PATH_DENIED。
- 二进制或非 UTF-8：415/UNSUPPORTED_ARTIFACT。
- 大于 512 KiB：413/LIMIT_EXCEEDED。

旧 attempt 的元数据仍可查询，Task.currentAttempt 明确指出它是否仍是当前执行；独立任务返回 null。没有产物快照隔离，因此旧内容只有在当前文件 hash 仍一致时才可读取。

摘要 evidenceCurrent 仅检查摘要来源消息与引用产物的一致性；不是业务正确性或整条交接链有效性的保证。model/extractive、持久化摘要状态和人工验收决定分别展示。Skill 显示的是创建任务时绑定的版本，不隐含当前文件仍匹配；接口不会自动升级、加载或执行 Skill。旧任务没有这些字段时返回 null 或空数组，不回写迁移。

## 模块与边界

`apps/server` 组合 core 的纯查询、adapters 的 FileStateReader / ReadOnlyWorkspace 和 contracts 的 HTTP 展示协议。ReadStateStore 类型没有保存、锁、回执、执行检查等方法。HTTP 模型通过白名单映射，内部新增字段不会自动公开；完整模型消息、推理字段、待执行工具队列、验证命令定义、原始命令输出和 Provider URL 不对外返回。

Server 文件读取拒绝符号链接与非普通文件，受文件大小限制，读取时不创建锁或修复日志。沿用本地可信工作区约束，不承诺抵御具有宿主权限的进程反复替换目录造成的所有竞态。

初版快照上限 8 MiB、单对象事件日志 16 MiB、单类集合 5,000 个快照、响应 4 MiB。列表在内存中筛选和分页，不适合大规模历史数据。只读读取器兼容缺少 workflows/events 等新目录的旧工作区；损坏快照明确报错，不静默丢弃记录。

## 验证与后续

自动化验证直接调用 Fetch 风格请求处理器和内存中的 Node HTTP 请求/响应适配器，不启动监听端口。覆盖只读性、CLI 持锁读取、字段投影、分页、事件增量、过期产物、链接拒绝、旧工作区与缺失记录；协议处理不需要模型密钥。实际监听及浏览器联调在开发机或 CI 环境进行。

MR 2 已基于同一协议实现 Web 列表、DAG、节点详情、时间线和指标展示；可增加 `--web apps/web/dist` 同源托管，步骤见 [Web 指南](web.md)。省略 --web 保留本指南的 API-only 行为。MR 3 已增加静态演示、回放和发布材料，见 [Demo 指南](../demo/README.md)。包版本统一为 v0.5.0-alpha.1，尚未对外发布。
