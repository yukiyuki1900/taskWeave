# 可复现评测

评测用于比较固定任务在同一模型、版本和参数下的结果。`eval:demo` 验证运行链路；真实模型质量需要配置用户自己的模型服务后测量。

## 两套用例

- `examples/evaluation/demo.json`：四类任务各一例，使用固定脚本，检查写入、持久化和验证链路。通过不代表模型有推理能力。
- `examples/evaluation/baseline.json`：20 个真实模型任务，需求、测试、文档、代码各 5 例。前三类主要检查字段或必要内容；代码类通过固定、位于用户配置中的 Node 断言检查。

前三类结构检查可能被内容空泛的产物满足，不衡量语义完整性或事实准确性。发布模型效果结论前，应补充人工盲评和独立保留集，记录评审标准。不要用调优后的同一组任务声称泛化能力。

## 运行

```bash
npm run eval:demo
node --env-file=.env bin/taskweave.mjs eval \
  --suite examples/evaluation/baseline.json \
  --workspace .cache/evaluations --limit 4 --max-steps 24 --timeout 300
```

`--suite` 基于当前目录，`--workspace` 为评测输出根目录。每次创建唯一运行目录，每例有自己的文件和 `.taskweave` 状态。用例串行执行，互不共享可写文件。基线中的命令运行模型生成代码，适用与 `run_checks` 相同的可信本地执行边界。

报告在每例完成后原子更新到 `<runDirectory>/report.json`，stdout 输出相同 JSON。单例失败不阻止其他用例；Ctrl+C 停止后续用例，报告的 `planned` 和 `executed` 可区分未执行部分。评测用例所使用的配置保存在各自 `.taskweave/config.json`，可继续检查任务状态。

## 指标定义

| 指标 | 含义 |
| --- | --- |
| `passed` | 状态 completed 且独立验证 passed |
| `passRate` | 已执行用例中检查通过的比例，不等于全部业务目标正确率 |
| `durationMs` | 各用例墙钟耗时之和，不包含评测初始化 |
| `modelCalls` | 累计模型轮次，失败请求也计入；适配器内部 HTTP 重试不单独计数 |
| `inputTokens` / `outputTokens` | 服务实际返回的 usage 累计；缺少 usage 时为 0，不是本地精确估算 |
| `toolCalls` / `toolFailures` | 模型工具执行次数及失败次数，不包含独立验证命令 |
| `humanInterventions` | 等待用户输入或人工验收的事件数，表示需要人工介入，不表示人已经处理 |

所有报告记录模式、Provider 标识、任务 ID、状态及失败原因。未验收、等待输入、预算耗尽和取消均不计通过。Token 没有返回时，0 也不意味着真实服务没有消耗费用；报告不估算金额。

## 自定义用例

```json
{
  "version": 1,
  "name": "custom",
  "cases": [{
    "id": "document-one",
    "kind": "document",
    "goal": "读取 brief.md，将安装说明写入 README.md，保留 npm ci 命令",
    "files": { "brief.md": "先执行 npm ci 安装依赖。" },
    "validation": {
      "rules": [{ "type": "contains", "path": "README.md", "text": "npm ci" }],
      "requireApproval": false
    }
  }]
}
```

顶层可增加 `config`，格式与验证配置一致。每个用例显式指定 `validation`，可开启人工验收以用于后续评审，但该轮自动报告会将等待验收记录为未通过。

建议比较时固定 Git 提交、任务集、Provider、模型与预算，多轮运行观察波动。保留任务快照、工具证据及未参与调优的任务；模型版本由服务商控制时，另外记录实际调用日期。
