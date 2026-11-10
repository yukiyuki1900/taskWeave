# 开源源码与发布说明

当前仓库准备的是 MIT 许可的 v0.5.0-alpha.1 源码候选及展示材料。仓库的 private 标记继续保留；本次不发布 npm、创建远端 tag、迁移 Git 历史或部署站点。公开仓库地址和平台由维护者确定，不编造已上线入口。

## 可交付内容

源码包含 CLI、core/adapters/contracts/evaluation、只读 Server、Web、公开固定示例、测试与文档。公开展示录制来自 `scripts/showcase/scenario.ts` 运行自己的全新工作区，再调用 API 白名单视图；不是个人会话、原始模型消息或真实业务工作区导出器。

README 有静态演示与真实运行两条路径；完整 Demo、截图、录屏、讲稿与 alpha 发布说明均可随源码交付。依赖版本由 lockfile 固定，MIT 文件和依赖原有许可证保留。

## 生成源码包

先提交所有待交付代码，再运行：

```bash
npm run release:source
# .cache/releases/TaskWeave-v0.5.0-alpha.1-source.tar.gz
# 同目录：.tar.gz.sha256 与 manifest.json
```

脚本拒绝脏工作区，导出 HEAD 的源码白名单；不会把未提交的实现悄悄漏在包外。归档没有 `.git`、历史提交、node_modules、构建缓存、`.env`、`.taskweave` 或个人工作目录；`.env.example` 保留。发现白名单内已提交的凭据文件或运行目录时会拒绝导出，不会自动改写原仓库。

归档不等于自动审核全部业务文本；维护者仍应核对新增示例、截图和文档的实际内容。公开录制已经只含本项目固定材料，不能将此结论推广为任意工作区都可直接公开。

## 在目标公开仓库验证

将源码包解压到一个新目录，核对 SHA-256 与 manifest 的版本和 commit 后执行：

```bash
npm ci --include=dev
NODE_ENV=test npm test
npm run typecheck
npm run check:boundaries
npm run web:build
npm run web:demo:build
```

开发机可运行 `npm run showcase:serve` 查看静态演示，或使用本地 Server 查看自己的工作区。Chromium 下载与截图捕获是单独的可选命令，见 [Demo 指南](demo/README.md)。一般贡献者无需先安装浏览器。

如决定使用新的公开 Git 历史，在解压目录按目标平台流程初始化和推送；不要未经核对直接镜像原远端历史。本工具只生成源码包，不执行这些外部操作。

## 发布顺序

1. 合入评审后的代码，核对 alpha 发布说明与实际验证结果。
2. 从对应干净 HEAD 生成归档及 SHA-256，在解压目录完成安装与检查。
3. 由维护者确定公开平台、仓库介绍及链接，再上传源码和演示材料。
4. 如需静态站点，部署 `apps/web/dist-demo/`；核对根路径/子路径资源、阶段深链接和“固定脚本”标记后再宣传入口。
5. tag、Release、npm 发布分别显式操作；当前 private 包不会因执行构建而自动发布。

建议仓库介绍：**Task-oriented agent runtime with explicit validation, human gates, attempt-bound handoff, and a read-only Web workbench.**

建议展示说明：**需求、代码、测试与文档共用一个 Agent 执行内核。通过固定脚本 Demo 观察验证失败、重试、人工门禁、交接和返工恢复；真实模型效果需要独立评测。**
