# 本地 Web 工作台（v0.5 MR 2）

Web 是已有 TaskWeave 工作区的只读观察界面。工作流、任务、报告和产物全部来自 MR 1 的 `/api/v1`，没有在浏览器中执行 Agent，也不提供输入、验收、返工、重试或取消按钮。

## 启动

在仓库根目录执行，需要 Node.js 20.19+（22 系列须 22.12+）及 npm：

```bash
npm ci --include=dev
npm run web:build
npm run server -- --workspace work/e2e-001 --port 4310 --web apps/web/dist
```

在开发机浏览器打开 `http://127.0.0.1:4310/#/workflows`。请使用 `127.0.0.1`，Server 不接收其他 Host。工作区必须已存在且有 `.taskweave/tasks`，不会自动初始化。可替换 `--workspace` 为自己的工作区；无需 `.env` 或模型密钥。

没有现成数据时，可以先用已有离线 CLI 演示创建工作区：

```bash
npm run workflow:demo
npm run server -- --workspace .demo/workflow --port 4310 --web apps/web/dist
```

`--demo` 是固定脚本，不代表真实模型效果，节点通常等待人工验收。验收命令继续按 [工作流指南](workflows.md) 操作，Web 会读取后续变化。MR 3 已补齐静态 Demo、回放与发布截图，见 [完整 Demo](../demo/README.md)。

省略 `--web` 时保留原 API-only 模式。Web 与 API 由一个 Server 同源提供，无需第二个开发服务器、代理或 CORS。CLI 执行进程仍独立，退出 Server 不会取消 CLI 任务。

页面使用 hash 路由，可复制当前节点、attempt 和页签地址，也可刷新页面：

```text
/#/workflows
/#/workflows/<run-id>?node=<node-id>&attempt=<attempt-id>&tab=context
/#/tasks
/#/tasks/<task-id>?tab=artifacts
```

源码改动后重新 `npm run web:build`，并重启 Server。静态资源在启动时加载至内存，运行期间不会重新加载构建目录。构建失败或目录缺少 index.html 时启动失败，不退回托管仓库或工作区。

## 页面与口径

- **工作流列表**：状态筛选、游标分页、节点成功数和更新时间。
- **任务列表**：默认独立任务，可切到全部任务查看工作流节点任务；展示步骤、Token 与 Provider 模式。
- **工作流详情**：依赖图、节点状态、执行历史。选择当前或历史 attempt，任务信息绑定对应 taskId，不用最新文件冒充旧结果。
- **指标**：复用 workflow report。切换当前/全部 attempt 的 Token 和调用统计；时间与人工操作是整个运行的统计，明确保持该口径。节点通过比例仅针对这一次运行，不是多个样本的 Agent 成功率。缺失数据和未归属时间明确提示。
- **节点任务页签**：目标与回答、登记产物、独立验证和人工意见、摘要证据、上游交接身份、绑定的 Skill 版本、任务事件。完整原始模型消息与命令输出不在 API 中，Web 不补读检查点。
- **事件**：工作流时间线与任务时间线分开；游标和去重键包含 scope、对象 ID 与 seq，不混用两个对象的序号。

待人工输入与待验收是运行状态，并非 Server 报错。请在 CLI 操作后观察状态变化。不存在的节点/attempt、无结果、旧任务缺少摘要或 Skill、关联记录不可读都有对应空态或提示。

## 更新与故障

列表首屏、详情、报告和已选产物每约 2 秒顺序轮询；事件按游标增量读取，积压页每约 100ms 追赶。不会叠加同一查询的请求，切换对象时中止旧请求，隐藏标签页暂停后续轮询，恢复可见时重新读取。单请求 15 秒超时，失败退避至最多 30 秒，支持手动刷新。

翻到列表历史页后停止自动刷新；状态或任务范围变化后回到首屏。通过“回到最新”恢复首屏轮询。只展示各请求观察到的快照，没有跨文件事务保证；工作流和报告观察到不同对象序号时提示正在同步。

普通查询失败时保留上次数据并明确标为更新失败。**产物重新校验失败会隐藏此前预览**，避免将已变化文件继续显示为有效结果。事件游标超前时清空旧时间线，从头重新读取；时间线最多保留最近 1,000 条，缺失提示不会因后续某一页成功而消失。

## 产物预览与历史限制

只读取该任务登记的 UTF-8 文本产物，上限 512 KiB。选中文件后展示记录/当前 SHA-256，Markdown 可切原始文本，JSON 可格式化，其余作为纯文本。HTML 不执行；Markdown 原始 HTML 转义、禁止脚本链接、不自动加载远程图片。

hash 不匹配返回 `ARTIFACT_CHANGED`，显示两个 hash，不显示变化后的内容；文件删除、权限拒绝、超限或格式不支持保留具体错误。历史 attempt 只有在当前文件仍匹配登记 hash 时能预览，没有历史产物版本库。

摘要区分模型/提取式来源、持久化状态和证据匹配；证据匹配不等于业务正确。交接显示来源 node/attempt/task、验证记录及产物 hash；Skill 显示创建任务时绑定的版本，不表示磁盘当前版本仍匹配。

## 实现边界

`apps/web` 使用 React、TypeScript、Vite，只依赖 contracts 的展示类型；数据访问集中在 `data/ReadClient`，使用同源 GET，不导入 core、adapters、Server、Node.js 或文件系统。接口规范见 [只读 API](read-api.md)。技术配置参考 [React TypeScript](https://react.dev/learn/typescript) 和 [Vite](https://vite.dev/guide/)。

Server 显式接收构建目录，仅托管 index.html 及白名单静态资源；拒绝链接和额外文件类型，最多 200 个文件、单文件 4 MiB、合计 16 MiB。不会以请求参数作为磁盘路径，也没有任意路径的 SPA fallback。API 未知路由保持 JSON 404，不回退为 HTML。使用 no-store、nosniff、same-origin、CSP；脚本仅允许同源，样式允许 React 图节点定位所需的内联样式。

这仍是本地单用户工具，不提供账号权限、远程部署、执行控制、WebSocket 或数据库；同源策略与本地监听沿用 MR 1。API 白名单之外不补读内部记录，但业务文本仍是用户显式生成的内容，不承诺自动语义脱敏。MR 1 的文件存储规模限制仍然适用，大规模历史查询需要后续索引与内存预算治理。

## 验证

```bash
npm ci --include=dev
NODE_ENV=test npm test
npm run typecheck
npm run check:boundaries
npm run web:build
```

设置 `NODE_ENV=test` 是为了在 React 开发版中启用 act；如果终端原本未设置 production，直接 `npm test` 也可。自动化使用内存 HTTP 处理器与 JSDOM，覆盖实际工作区 API 到页面、历史切换、产物变化、迟到请求、事件去重、路由与安全渲染。测试不启动监听端口、不请求真实模型；JSDOM 不验证布局、真实浏览器 CSP 或 TCP 监听，需在开发机/CI 补充浏览器联调。

包版本统一为 v0.5.0-alpha.1。Demo、回放、截图、录屏和发布材料已补齐，尚未对外发布或部署。
