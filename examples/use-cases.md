# 四类任务示例

以下示例假设你已在进程环境中配置模型地址、名称和密钥。把输入资料放到 `work/` 的普通可见文件中，例如 `work/brief.md`、`work/src/`。执行前保留原文件副本或使用版本控制。

## 从目标形成需求与子任务

```bash
npm start -- run --kind requirements --workspace work --prompt \
  "设计团队待办应用。成员可以创建任务、指派负责人、设置截止时间；状态为待办、进行中、已完成。先澄清会影响实现的关键问题，再将角色权限、状态流转、异常场景和可验证验收标准写入 artifacts/requirements.md，并创建开发和测试子任务。不要假设已有代码。"
```

如果任务暂停，用 `show` 查看问题，再通过同一工作区的 `resume <id> --answer "..."` 回答。完成后 `list` 查看子任务，按 ID 单独执行。

## 根据需求设计测试

```bash
npm start -- run --kind tests --workspace work --prompt \
  "读取 artifacts/requirements.md，输出 artifacts/test-plan.md。按需求标识关联正常、边界、异常和权限测试，标注前置条件、操作步骤与预期结果。先检查是否有测试框架；有源码依据时才生成适用的测试代码。明确说明测试未实际执行，并把需补充的测试工作创建为子任务。"
```

## 根据源码生成文档

```bash
npm start -- run --kind document --workspace work --prompt \
  "阅读 src/ 中的代码与现有说明，在 artifacts/architecture.md 说明模块职责、主要调用流程、输入输出和已知限制。结论附相关文件路径。无法从代码确认的部署方式与配置不要编造，必要时提问。"
```

## 修改代码并说明验证边界

```bash
npm start -- run --kind code --workspace work --prompt \
  "检查 src/ 中的标题规范化函数。要求去除首尾空白，将连续内部空白压缩为一个空格，并为字符串输入增加边界测试。先读取目标文件再进行最小修改，保留其他逻辑；没有可确认的函数或框架时先提问。最终说明改动文件与需要由我执行的验证命令，不声称已经运行测试。"
```

## 无密钥演示

可以将上面命令加上 `--demo` 体验工具、事件和产物保存流程；此时提示词不会被真实理解，输出来自各类型固定模板。代码类演示只生成一个独立的标题规范化样例文件，不会修改已有业务逻辑。
