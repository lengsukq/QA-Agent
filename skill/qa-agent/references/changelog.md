# 更新日志

## v0.3.7

v0.3.7 将 AI 主导和用户主导统一到同一套 Task、Plan、Run、Step、Evidence 和 Report 内核，只在"谁决定下一步"上采用不同控制策略：

- Agent 先创建 Task，再根据源码生成包含"步骤、操作、预期结果"的详细测试 PRD；
- PRD 中存在需求、环境、账号、测试数据、预期结果或安全疑问时，Agent 必须先逐项询问 QA；
- QA 首先明确回复"确认测试方案"，表示 PRD 符合需求；
- QA 再单独回复"确认开始测试"，Runtime 才允许创建 Run 和调用 UI 工具；
- AI 主导模式按已批准 PRD 连续执行，不需要每一步额外准备或人工确认；
- 用户主导模式每次只保存一个待处理交互：先批准一个操作，执行并截图后，再确认该步骤结果；
- 单步批准和 verdict 直接保存在对应 Step 上，不再维护独立的阶段、审批历史和 verdict 历史状态机；
- 用户主导 Run 完成后，Runtime 自动为每个已选 Scenario 生成一个独立 Python 回归脚本草稿；
- 场景脚本保存在 `source-run/scenario-regressions/<scenario-id>/`，正式发布仍需要单独审核和批准；
- AI 主导 Run 完成且满足条件时，Agent 仍会询问是否生成完整流程的 Python 回归脚本草稿；
- Runtime 保存真实截图、业务断言、Cleanup、人工决策和正式报告；
- PRD、测试报告和场景回归脚本会通过可点击 Markdown 链接主动展示；
- 正式测试报告和回归报告必须在 Markdown 内直接嵌入截图，单纯列出截图路径无效；
- `qa-agent-regression-test` 只运行已经发布的脚本；
- 固定测试矩阵、Release Check、GO/NO-GO 和 Archive 能力继续由主 `qa-agent` 与 Runtime 提供。

### 全新初始化

v0.3.7 不提供跨版本迁移，也不会读取或转换旧 `.qa-agent` 资产。项目必须使用本版本重新初始化。需要保留旧结果时，先把旧目录作为普通备份移出，再初始化：

```bash
mv .qa-agent .qa-agent.backup
qa-agent init
```

`qa-agent update` 只刷新由同一 0.3.7 Runtime 创建的托管文件；版本不一致会直接拒绝执行。
