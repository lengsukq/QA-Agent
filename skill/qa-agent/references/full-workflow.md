# 完整使用流程

用户可以选择两种首次测试方式：

```text
普通模式：帮我测试登录流程。
Guided 模式：以 QA 引导模式测试首次安装的 Welcome Dialog。
```

普通模式由 AI 按已批准 PRD 连续执行；Guided 模式由 QA 决定每一步是否执行，并判断实际结果是否符合预期。

## 1. 创建或恢复 Task

普通请求调用：

```bash
qa-agent check --request "测试登录流程"
```

Guided 请求调用：

```bash
qa-agent check --mode guided --request "测试首次安装 Welcome Dialog"
```

两种模式都只会：

- 创建或复用 Module 与 Task；
- 绑定当前 Session；
- 生成初始 `task.json`、`requirements.json`、`test-plan.json`、`prd.md` 和 Scenario；
- 进入 `planning`。

此时不会创建 Run，也不允许操作浏览器、模拟器或设备。固定测试矩阵、发布范围、影响分析和 GO/NO-GO 仍由主 `qa-agent` 处理，不再需要单独的 Plan Skill。

## 2. 阅读项目并生成详细 PRD

Agent 阅读相关源码、路由、页面、状态管理、测试、配置和已有 QA 资产，然后通过 `qa-agent plan apply` 写入结构化计划。每个 Scenario 必须包含：

- 测试目标、范围、前置条件、输入和预期业务结果；
- 按顺序执行的步骤；
- 每一步的"操作"和"预期结果"；
- 业务或视觉断言、截图要求和 Cleanup；
- 风险、优先级、需求和源码引用。

计划变化会同时使旧的"方案确认"和"开始授权"失效；与旧 Plan Hash 绑定的正式回归步骤会变为 `stale`。

## 3. 解决疑问并确认测试方案

Agent 必须展示完整 Task PRD。如果存在以下任何不确定内容，必须暂停并向 QA 提问：

- 真实需求或业务规则；
- 测试环境、平台和角色；
- 账号、测试数据或前置状态；
- 每一步预期结果；
- 支付、删除、通知等危险操作。

问题保存在 `requirements.json` 的 `userQuestions`，QA 的答案写入 `confirmedDecisions`。解决后 Agent 重新应用 PlanDraft 并再次展示 PRD。

当 PRD 已符合需求时，QA 必须明确回复：

```text
确认测试方案
```

Agent 通过 `qa-agent plan review` 保存真人确认。只要还有未解决问题，Runtime 就会拒绝方案确认。

## 4. 单独授权开始测试

"确认测试方案"只表示 PRD 正确，不代表允许操作设备。准备执行时，QA 还必须单独回复：

```text
确认开始测试
```

Agent 使用 `qa-agent review` 保存开始授权。`可以`、`继续`、`没问题` 等模糊回复不能替代这两个门禁。

## 5. 预检并启动 Source Run

两个门禁都通过后，`qa-agent test` 检查：

- 当前 PRD、Plan Hash 和两次确认是否仍一致；
- 浏览器、模拟器、设备和 Host Bridge 能力；
- Android/iOS 系统权限；
- 环境、角色、测试数据和安全策略。

预检通过后创建 Task 唯一的 Source Run。普通模式会返回 `uiExecutionAllowed=true`；Guided 模式会先进入"等待 QA 批准下一步"，因此有 `runId` 但暂不允许 UI 操作。

## 6. 普通模式执行

普通模式下，Agent 按已批准 PRD 连续执行，并通过 Runtime 保存：

- 每一个真实 UI 操作、实际定位器、输入引用、预期状态和实际状态；
- 每一步截图；
- 所有业务或视觉断言；
- Cleanup、日志、网络结果和其他 Evidence；
- 有限次数的恢复尝试。

Agent 不得跳过声明的业务断言，也不得伪造截图、操作或结果。

## 7. Guided 模式逐步互动

Guided 模式强制执行以下循环：

```text
AI 提出一个操作和预期结果
→ QA 决定是否执行
→ Runtime 记录单步批准
→ AI 只执行这一项操作并截图
→ AI 展示实际结果
→ QA 判断 passed / failed / blocked / paused / inconclusive
→ Runtime 记录 QA verdict
→ 才能进入下一步
```

对应命令：

```bash
qa-agent run guide-approve RUN   --scenario SCENARIO   --planned-step STEP   --confirmed-by QA   --confirmation-text "是的，执行这一步"

qa-agent run step RUN ...

qa-agent run guide-verdict RUN   --step STEP   --status passed   --confirmed-by QA   --confirmation-text "是的，符合预期"
```

没有单步批准时，Runtime 禁止 UI；操作完成后没有 QA verdict 时，Runtime 禁止下一项 UI 操作和 `run complete`。QA 也可以在执行中新增操作，但必须同时明确操作和预期结果，不能悄悄修改旧 PRD 的业务预期。

## 8. 完成 Run 并保存 Case

只有所有已选 Scenario 的断言、Cleanup，以及用户主导模式下每个 UI Step 的批准和 verdict 都完整后，`qa-agent run complete` 才会成功。Runtime 随后：

1. 计算 Scenario 和整体业务结果；
2. 保存 `source-run/run.json`；
3. 生成 `source-run/report.md`；
4. 保存截图、Evidence、恢复记录和人工决策；
5. AI 主导模式评估完整流程是否具备导出回归步骤的条件；
6. 用户主导模式为每个已选 Scenario 自动生成一个独立步骤文件和 manifest。

Quick Task 会把结果和关键截图写回同一个 `prd.md` 并进入 `completed`。用户主导 Task 会把每个 Scenario 的步骤保存在：

```text
source-run/scenario-regressions/<scenario-id>/steps.json
source-run/scenario-regressions/<scenario-id>/manifest.json
```

这些文件是基于人工批准和 verdict 生成的草稿，不会自动发布或执行。

## 9. 回归步骤脚本

AI 主导模式只有在 Source Run 完成且证据充分时，才会询问是否导出完整流程的回归步骤（steps.json）。用户主导模式不再询问同一个问题，因为 Runtime 已经按 Scenario 自动生成草稿。

无论来源是哪一种模式，正式发布都必须经过单独审核和批准。发布后的回归步骤先是 `approved_unverified`，至少完成一次合法执行合同后才成为 `validated`。后续 Task、Module 和 Release 回归由 `qa-agent-regression-test` 或 Runtime 回归命令执行。

## 10. 继续、结束与归档

- `qa-agent continue`：从持久化状态恢复当前允许的下一步，包括待回答问题、PRD 确认、开始授权、Guided 单步批准或结果 verdict。
- `qa-agent finish`：结束当前 Session，不等于删除或归档 Task。运行中的 Run 不能直接结束。
- `qa-agent archive`：只有当前审批、成功 Source Run、报告、截图、validated 回归覆盖、回归合同和 Memory Gate 全部满足时才改变为 `archived`。

## Quick Check 与 Guided Check

普通 AI 主导模式：

```bash
qa-agent check --request "测试登录流程"
```

QA 主导模式：

```bash
qa-agent check --mode guided --request "测试首次安装 Welcome Dialog"
```

两者共享相同的 PRD 双门禁：

```bash
qa-agent plan review   --module MODULE   --task TASK   --approve   --confirmed-by QA   --confirmation-text "确认测试方案"

qa-agent review   --module MODULE   --task TASK   --approve   --confirmed-by QA   --confirmation-text "确认开始测试"

qa-agent test --module MODULE --task TASK
```

区别只在执行阶段：普通模式由 AI 按计划连续执行；Guided 模式每一步都要求 QA 的操作批准和结果判定。
