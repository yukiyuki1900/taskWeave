# 验证与验收

模型最终回答表示生成阶段结束，独立验证负责检查配置规则；人工验收负责业务判断。默认所有任务需要人工验收。

## 配置

推荐由用户维护工作区 `.taskweave/config.json`。默认缺失时使用空命令列表和人工验收。文件工具无法访问隐藏配置；配置加载拒绝软链、父目录和过大文件。显式配置路径基于所选工作区。

```json
{
  "version": 1,
  "checks": {
    "unit": {
      "command": "node",
      "args": ["--test", "test/smoke.test.mjs"],
      "cwd": ".",
      "timeoutMs": 30000,
      "maxOutputBytes": 16384
    }
  },
  "validation": {
    "code": { "checks": ["unit"], "requireApproval": true },
    "document": {
      "rules": [
        { "type": "exists", "path": "README.md" },
        { "type": "contains", "path": "README.md", "text": "## 使用说明" }
      ],
      "requireApproval": true
    },
    "requirements": {
      "rules": [{ "type": "json_fields", "path": "spec.json", "fields": ["scope", "stories", "acceptance"] }],
      "requireApproval": true
    }
  }
}
```

`exists` 要求目标是可读取、有限大小的普通文本文件。`contains` 为区分大小写的字面量匹配。`json_fields` 只检查 JSON 对象的顶层字段存在，不推断字段类型和内容是否正确。它们使用与文件工具相同的路径规则。

未配置的任务类型默认 `rules: []`、`checks: []`、`requireApproval: true`。显式 `requireApproval: false` 时必须至少有一项规则或检查。TypeScript API 也可通过 `TaskInput.validationPolicy` 指定任务策略。

## 命令执行

- `run_checks` 只接受 `{ "checks": ["unit"] }`，拒绝未知名称和额外字段；无命令配置时不向模型开放此工具。
- 使用 `spawn(command, args, { shell: false })`，不进行 Shell 展开。命令和所有参数由用户配置，模型不能覆盖。
- 工作目录必须是工作区内、非隐藏且无软链的普通目录。
- 子进程仅继承 PATH、SystemRoot、WINDIR、TEMP、TMP、LANG 中存在的变量，不继承完整进程环境、模型密钥、HOME 或 NODE_OPTIONS。
- 命令超时默认 30 秒、最多 120 秒；stdout 与 stderr 共用输出字节上限，默认 16 KiB、最多 64 KiB。
- 超时、取消或输出超限会停止命令；POSIX 下终止进程组并在宽限期后强制停止。Windows 只终止直接子进程，不承诺完整清理后代进程。
- 结果包含状态、退出码、stdout、stderr 和耗时。状态为 `passed`、`failed`、`timeout`、`cancelled`、`output_limit` 或 `unknown`。
- 发给模型的同批命令输出额外限制为约 16K 字符，使用 `outputTruncated` 标明截断；执行记录保留命令原有输出上限内的内容。验收失败反馈也只发送有长度上限的失败证据摘录。

这不是进程沙箱：可信命令也可能执行模型生成的代码，代码仍具有宿主用户的文件与网络权限。不要将该功能直接开放为不可信多租户服务。最小环境继承也不代表子进程无法读取磁盘上的凭据。输出会持久化并进入模型上下文，需由用户确保不含敏感资料。

## 状态与证据

`Task.validationPolicy` 固化任务验收规则；`executionConfigHash` 绑定规范化配置的 SHA-256。配置变化时恢复、验证和验收均拒绝执行。子任务继承相应任务类型的策略。

`Task.validation` 保存本轮验证 ID、时间、状态和逐项结果；历史保留最近 20 轮。产物完整性检查在命令之后进行，避免命令修改文件后使用旧 hash。最终命令检查有独立执行记录，不复用模型早先调用命令的结果。

验证失败进入 `validation_failed`，`resume` 把失败项或退回意见作为新用户消息交给模型，继续使用原累计预算。需要时用 `--max-steps` 提高预算。v0.2 采用显式恢复，不自动无限返工。

检查通过默认进入 `waiting_acceptance`。`accept --note` 会新建验证轮次，重新执行命令和规则，再保存人工验收记录；失败则保持未完成。`reject --note` 保留退回意见，供下次 `resume` 使用。验收命令不需要模型 Key。

验证 ID 表示一次检查，区别于 v0.3 工作流节点的 attempt；每次 attempt 拥有独立任务与验证记录，见 [工作流说明](workflows.md)。

## 中断语义

工具批次先存快照，再执行副作用；命令执行前另存 `started`，结束后存 `finished` 和结果。

- `finished` 已保存：恢复同一调用时复用结果。
- 只有 `started`：返回 `unknown`，不自动重复命令。
- 生成回答已保存、尚未验证：恢复只进入验证，不再次调用模型。
- 验证中断：复用本轮验证 ID 和命令记录；如果结果未知，验证失败。
- 核实副作用后，用户显式 `validate` 可以创建新一轮检查，再次执行命令。

每一轮验证及人工接受都会再次运行所配置的命令，请配置可重复执行的检查，并避免部署、支付、发送消息等外部写入。
