# 更新日志

## v0.3.97

- PlanDraft 步骤新增 `regressionStep` 字段，执行通过后 Runtime 自动回填统一执行器 JSON 片段。
- 新增 check 命令：Web `assert-value/assert-not-visible/assert-attribute/assert-count`；iOS `assert-not-visible/assert-attribute/assert-count`。
- 新增高频命令：Web `check/uncheck/get-text/upload/accept-dialog/dismiss-dialog`；iOS `toggle/get-text/accept-dialog/dismiss-dialog`。
- 虚拟环境管理：Doctor 引导在 `.qa-agent/venv/` 下创建 venv；Runtime 解析优先级 `QA_AGENT_PYTHON` > `.qa-agent/venv/bin/python` > `python3`。

## v0.3.96

- 平台声明改为 Agent 基于源码、配置和可用能力自动判断；只有平台证据不明确时才询问 QA。
- 新增 `executionIntent` 和 `confirmationMode`，低风险只读流程支持一次“确认测试并开始执行”确认。
- 平台切换会使旧平台绑定审批失效，并要求按新计划重新确认；旧 Task 缺失执行意图时默认严格模式。

## v0.3.95

- 验证 iOS 统一 Runner 在 iPhone 17 Pro Max Simulator 上完成搜索、输入、清空、键盘、滚动、语义点击和详情页断言。
- 修复 iOS `assert-text`、locator 复合 `AXLabel` 匹配、动态尺寸滚动和失败后回归步骤停止执行。
- 新增 [`ios-search-bvl.steps.json`](../../../ios-search-bvl.steps.json) 作为可直接回放的 `com.rechic.apps` 搜索到商品详情示例，并同步 CLI、回归 Runner 契约文档。

## v0.3.94

- 生成详细测试计划后，要求 QA 明确声明本次测试平台为 Web 或 iOS Simulator。
- 平台声明写入 `PlanDraft.platformDeclaration` 和 Task Requirements；未声明时工作流、方案复审和 Quick/Guided 执行均阻塞。
- 平台切换必须重新应用包含新平台声明的 PlanDraft，并继续执行 Doctor、方案确认和开始确认流程。
- 不迁移旧 Runtime 资产；0.3.94 使用全新初始化，Runner 通过全局/npm 包解析。旧版本需备份后重新 `qa-agent init`。

## v0.3.93

- 锁定 Web/iOS Simulator 的内置 Runner，移除 MCP 作为 UI 执行路径。
- 新增平台不匹配时先运行 Doctor、重新应用 PlanDraft 的引导。
- 支持全局环境变量和 npm 包内 Runner 解析，`init` 不再复制 Runner 到项目。
- 简化执行契约哈希：标题、描述和模块展示快照变化不再让回归步骤失效。
- 增加 v0.3.92 项目的兼容升级逻辑。

## v0.3.92

- npm 包包含统一 Python 执行器，初始化或更新项目时复制到 `.qa-agent/runner`；
- Python Driver、JSON 回放和 Doctor 诊断统一使用托管 Runner 路径；
- 新增 `qa-agent-doctor` 首次环境引导 Skill，按步骤解释阻塞项和推荐项，不自动安装第三方依赖。

## v0.3.7

v0.3.7 将 AI 主导和用户主导统一到同一套 Task、Plan、Run、Step、Evidence 和 Report 内核，只在"谁决定下一步"上采用不同控制策略：

- Agent 先创建 Task，再根据源码生成包含"步骤、操作、预期结果"的详细测试 PRD；
- PRD 中存在需求、环境、账号、测试数据、预期结果或安全疑问时，Agent 必须先逐项询问 QA；
- QA 首先明确回复"确认测试方案"，表示 PRD 符合需求；
- QA 再单独回复"确认开始测试"，Runtime 才允许创建 Run 和调用 UI 工具；
- AI 主导模式按已批准 PRD 连续执行，不需要每一步额外准备或人工确认；
- 用户主导模式每次只保存一个待处理交互：先批准一个操作，执行并截图后，再确认该步骤结果；
- 单步批准和 verdict 直接保存在对应 Step 上，不再维护独立的阶段、审批历史和 verdict 历史状态机；
- 用户主导 Run 完成后，Runtime 自动为每个已选 Scenario 生成一个独立回归步骤草稿（steps.json）；
- 场景步骤保存在 `source-run/scenario-regressions/<scenario-id>/`，正式发布仍需要单独审核和批准；
- AI 主导 Run 完成且满足条件时，Agent 仍会询问是否导出完整流程的回归步骤草稿（steps.json）；
- Runtime 保存真实截图、业务断言、Cleanup、人工决策和正式报告；
- PRD、测试报告和场景回归步骤会通过可点击 Markdown 链接主动展示；
- 正式测试报告和回归报告必须在 Markdown 内直接嵌入截图，单纯列出截图路径无效；
- `qa-agent-regression-test` 只运行已经发布的回归步骤脚本；
- 固定测试矩阵、Release Check、GO/NO-GO 和 Archive 能力继续由主 `qa-agent` 与 Runtime 提供。

### 全新初始化

v0.3.7 不提供跨版本迁移，也不会读取或转换旧 `.qa-agent` 资产。项目必须使用本版本重新初始化。需要保留旧结果时，先把旧目录作为普通备份移出，再初始化：

```bash
mv .qa-agent .qa-agent.backup
qa-agent init
```

`qa-agent update` 只刷新由同一 0.3.7 Runtime 创建的托管文件；版本不一致会直接拒绝执行。
