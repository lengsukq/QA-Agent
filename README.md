# QA Agent

QA Agent 是一个项目级 AI 测试运行时。它让开发者直接用自然语言发起真实 UI 检查，同时自动保存 Task、Run、截图、业务观察、Cleanup 和测试报告。

当前版本：**v0.3.4**

v0.3.4 增加了双重 PRD 审批和 QA 主导的 Guided 模式：

- Agent 先创建 Task，再根据源码生成包含“步骤、操作、预期结果”的详细测试 PRD；
- PRD 中存在需求、环境、账号、测试数据、预期结果或安全疑问时，Agent 必须先逐项询问 QA；
- QA 首先明确回复“确认测试方案”，表示 PRD 符合需求；
- QA 再单独回复“确认开始测试”，Runtime 才允许创建 Run 和调用 UI 工具；
- 普通 `qa-agent` 由 AI 按已批准 PRD 连续执行；
- 新的 `qa-agent-guided` 由 QA 主导，每个 UI 操作前必须批准，操作后必须确认实际结果；
- Runtime 保存每一步截图、QA 决策、业务断言、Cleanup 和正式报告；
- 测试完成后，可在单独批准下生成和发布 Python 回归脚本；
- `qa-agent-regression-test` 只运行已经发布的脚本；
- 固定测试矩阵、Release Check、GO/NO-GO 和 Archive 能力继续由主 `qa-agent` 与 Runtime 提供。

## 适合解决什么问题

QA Agent 适合以下场景：

- 测试 Web、Android 或 iOS 功能；
- 让 Agent 读取项目源码后规划测试入口；
- 保存每次真实操作、截图和业务结果；
- 中断后继续当前测试；
- 将验证过的流程升级为可重复回归；
- 发布前执行影响分析和 GO/NO-GO 检查。

QA Agent 不替代浏览器、模拟器或设备工具。宿主 Agent 负责调用 Playwright、ADB、iOS Simulator MCP 等工具；QA Agent Runtime 负责状态、安全、证据、报告和回归资产。

## 安装

要求：

- Node.js 22.6 或更高版本；
- 一个支持 Skill、命令或项目规则的 Agent 宿主；
- 执行真实 UI 测试时，需要浏览器、模拟器或设备操作能力。

全局安装：

```bash
npm install -g qa-agent-skill
```

确认版本：

```bash
qa-agent --version
```

应输出：

```text
0.3.4
```

## 初始化项目

进入被测项目：

```bash
cd /path/to/project
qa-agent init
```

同时配置宿主：

```bash
qa-agent init --cursor
qa-agent init --codex
qa-agent init --claude
qa-agent init --copilot
qa-agent init --gemini
qa-agent init --opencode
qa-agent init --agents
```

可同时选择多个宿主：

```bash
qa-agent init --cursor --codex --claude
```

也可以一次配置指定项目：

```bash
qa-agent configure \
  --project /path/to/project \
  --host cursor
```

初始化后，Runtime 数据保存在：

```text
.qa-agent/
```

普通用户不需要手动修改其中的 JSON 文件。

## 首次运行检查（推荐）

项目初始化完成后，建议先运行：

```bash
qa-agent doctor
```

Doctor 会检查：

- `.qa-agent/` 项目是否初始化完整；
- 当前宿主、浏览器、模拟器或设备能力是否可用；
- 已配置平台对应的推荐 Python 回归环境；
- 缺失的工具、权限和可能阻止真实 UI 执行的问题。

推荐技术栈缺失只会作为建议提示，不会自动阻止 QA Agent。浏览器、模拟器、设备或必要权限等真实执行能力缺失时，应先按 Doctor 的提示修复，再开始第一次测试。

推荐的首次使用顺序：

```text
安装 QA Agent
→ 初始化被测项目和 Agent 宿主
→ qa-agent doctor
→ 修复必要的能力或权限问题
→ 在 Agent 对话中发起第一次测试
```

## 推荐回归技术栈

这是 QA Agent 的默认推荐方案，不是强制依赖。项目已有自动化框架时，只要能够直接命令行执行、输出 QA Agent `result.json`、生成 Runtime 报告并保存必要截图，就可以继续使用现有方案。

### Web 外部端

```text
Python 3.12+ + pytest + pytest-playwright + Playwright
```

用于浏览器操作、稳定定位、断言和截图。

### iOS 模拟器端

```text
Python 3.12+ + pytest + xcrun simctl + fb-idb CLI + idb_companion
```

由 `simctl` 管理模拟器、应用、权限和截图，由 `fb-idb` 与 `idb_companion` 执行 UI 自动化，由 pytest 管理 Fixture、断言、参数化和 Cleanup。

### Agent 辅助探索

`ios-simulator-mcp` 可用于首次探索和截图，但不作为正式 Python 回归脚本的唯一依赖。

### 正式输出

```text
result.json
+ report.md
+ screenshots/
+ stdout.log
+ stderr.log
+ evidence/（按需）
```

Doctor 的首次运行说明见上文。推荐工具缺失不会自动阻止 QA Agent。

完整说明见：

```text
skill/qa-agent/references/recommended-regression-stack.md
```
## 当前完整使用流程

用户可以选择两种首次测试方式：

```text
普通模式：帮我测试登录流程。
Guided 模式：以 QA 引导模式测试首次安装的 Welcome Dialog。
```

普通模式由 AI 按已批准 PRD 连续执行；Guided 模式由 QA 决定每一步是否执行，并判断实际结果是否符合预期。

### 1. 创建或恢复 Task

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

### 2. 阅读项目并生成详细 PRD

Agent 阅读相关源码、路由、页面、状态管理、测试、配置和已有 QA 资产，然后通过 `qa-agent plan apply` 写入结构化计划。每个 Scenario 必须包含：

- 测试目标、范围、前置条件、输入和预期业务结果；
- 按顺序执行的步骤；
- 每一步的“操作”和“预期结果”；
- 业务或视觉断言、截图要求和 Cleanup；
- 风险、优先级、需求和源码引用。

计划变化会同时使旧的“方案确认”和“开始授权”失效；与旧 Plan Hash 绑定的正式 Python 脚本会变为 `stale`。

### 3. 解决疑问并确认测试方案

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

### 4. 单独授权开始测试

“确认测试方案”只表示 PRD 正确，不代表允许操作设备。准备执行时，QA 还必须单独回复：

```text
确认开始测试
```

Agent 使用 `qa-agent review` 保存开始授权。`可以`、`继续`、`没问题` 等模糊回复不能替代这两个门禁。

### 5. 预检并启动 Source Run

两个门禁都通过后，`qa-agent test` 检查：

- 当前 PRD、Plan Hash 和两次确认是否仍一致；
- 浏览器、模拟器、设备和 Host Bridge 能力；
- Android/iOS 系统权限；
- 环境、角色、测试数据和安全策略。

预检通过后创建 Task 唯一的 Source Run。普通模式会返回 `uiExecutionAllowed=true`；Guided 模式会先进入“等待 QA 批准下一步”，因此有 `runId` 但暂不允许 UI 操作。

### 6. 普通模式执行

普通模式下，Agent 按已批准 PRD 连续执行，并通过 Runtime 保存：

- 每一个真实 UI 操作、实际定位器、输入引用、预期状态和实际状态；
- 每一步截图；
- 所有业务或视觉断言；
- Cleanup、日志、网络结果和其他 Evidence；
- 有限次数的恢复尝试。

Agent 不得跳过声明的业务断言，也不得伪造截图、操作或结果。

### 7. Guided 模式逐步互动

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

### 8. 完成 Run 并保存 Case

只有所有已选 Scenario 的断言、Cleanup 和 Guided 人工 verdict 都完整后，`qa-agent run complete` 才会成功。Runtime 随后：

1. 计算 Scenario 和整体业务结果；
2. 保存 `source-run/run.json`；
3. 生成 `source-run/report.md`；
4. 保存截图、Evidence、恢复记录和 QA 决策；
5. 评估是否具备生成 Python 回归脚本的条件。

Quick Task 会把结果和关键截图写回同一个 `prd.md` 并进入 `completed`。Guided Task 会保留完整人工确认链路，方便继续完善或转成回归 Case。

### 9. 可选：生成 Python 回归

只有完成且证据充分的 Source Run 才可能具备生成脚本的资格。这里仍有两次独立批准：

1. QA 同意创建 Session 草稿；
2. QA 查看完整脚本或 Diff 后，单独批准发布到 Task。

发布后的脚本先是 `approved_unverified`，至少完成一次合法执行合同后才成为 `validated`。后续 Task、Module 和 Release 回归由 `qa-agent-regression-test` 或 Runtime 回归命令执行。

### 10. 继续、结束与归档

- `qa-agent continue`：从持久化状态恢复当前允许的下一步，包括待回答问题、PRD 确认、开始授权、Guided 单步批准或结果 verdict。
- `qa-agent finish`：结束当前 Session，不等于删除或归档 Task。运行中的 Run 不能直接结束。
- `qa-agent archive`：只有当前审批、成功 Source Run、报告、截图、validated Python 覆盖、回归合同和 Memory Gate 全部满足时才改变为 `archived`。

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

## 生成文件与用途

QA Agent 的持久化数据默认位于项目根目录的 `.qa-agent/`。目录采用“项目 → Module → Task → Source Run / Regression Run”的结构。部分目录只有在对应功能首次使用后才会出现。

### 完整目录结构

```text
.qa-agent/
├── project.json
├── policies.json
├── mcp.json
├── accounts.example.json
├── .version
├── .configured-hosts.json
├── .template-hashes.json
├── schemas/
├── skills/
│   └── built-in/
├── index/
│   ├── modules.json
│   ├── tasks.json
│   ├── memories.json
│   └── skills.json
├── .runtime/
│   ├── current-task.json
│   ├── sessions/
│   │   ├── <session>.json
│   │   └── <session>.closed.json
│   └── drafts/
│       └── <session>/<script-id>/
│           ├── draft.json
│           └── <script-id>.py
├── .locks/
├── shared-memory/
│   ├── project-profile.json
│   └── entries/
├── modules/
│   └── <module>/
│       ├── module.json
│       ├── memory/
│       ├── reports/
│       └── tasks/
│           └── <task>/
│               ├── task.json
│               ├── module-snapshot.json
│               ├── requirements.json
│               ├── test-plan.json
│               ├── prd.md
│               ├── events.jsonl
│               ├── scenarios/
│               │   └── <scenario-id>.json
│               ├── memory/
│               ├── source-run/
│               │   ├── run.json
│               │   ├── report.md
│               │   ├── screenshots/
│               │   │   └── steps/
│               │   └── evidence/
│               │       └── artifacts/
│               ├── regression/
│               │   ├── <script-id>.py
│               │   └── <script-id>.json
│               └── regression-runs/
│                   └── <pyreg-run-id>/
│                       ├── run.json
│                       ├── result.json
│                       ├── report.md
│                       ├── stdout.log
│                       ├── stderr.log
│                       ├── screenshots/
│                       └── evidence/
├── impact-analysis/
│   └── <impact-id>.json
├── regression-runs/
│   └── <batch-run-id>.json
├── release-checks/
│   └── <release-id>.json
└── reports/
    ├── <batch-run-id>.md
    └── <release-id>.md
```

### 项目级文件

| 文件或目录 | 用途 |
| --- | --- |
| `project.json` | QA 项目的身份、名称、业务目标、平台、环境、角色和默认执行上下文。它是查找项目根目录的入口。 |
| `policies.json` | 安全模式、禁止操作、必须停止确认的副作用和生产写入策略。执行每一步前都会受它约束。 |
| `mcp.json` | 宿主提供的浏览器、模拟器、设备能力以及权限证明。Doctor 和 Run 预检会读取它。 |
| `accounts.example.json` | 测试账号引用示例，只应保存 `env:` 等 Secret Reference，不保存真实密码或 Token。 |
| `.version` | 当前 `.qa-agent` Runtime 资产版本。`qa-agent update` 会同步为当前 npm 包版本。 |
| `.configured-hosts.json` | Runtime 已管理的 Cursor、Codex、Claude 等宿主集成记录。 |
| `.template-hashes.json` | 宿主托管文件的模板状态，用于更新时识别冲突和用户修改。 |
| `schemas/` | Runtime 管理的 JSON Schema，用于验证 Project、Task、Scenario、Run、Release 等资产。 |
| `skills/built-in/` | Runtime 内部能力合同，例如执行、证据、报告、Memory 和 Python Regression。它们不是用户对话中的三个宿主 Skill。 |
| `index/*.json` | 从 Module、Task、Memory、Run 和脚本重新汇总的查询索引。它们便于 list、continue 和上下文恢复，但不是权威数据，丢失后可用 `qa-agent index rebuild` 重建。 |

### Module 与 Task 定义文件

| 文件或目录 | 用途 |
| --- | --- |
| `modules/<module>/module.json` | 一个业务模块的目标、风险、平台、角色、入口、核心流程、业务规则和源码提示。 |
| `task.json` | Task 的轻量主清单：名称、状态、优先级、模式、审批策略，以及对 Scenario、Source Run、报告和 Python 脚本的引用。 |
| `module-snapshot.json` | Task 创建时冻结的 Module 业务上下文、版本和 Hash，避免模块后来变化后无法解释历史测试依据。 |
| `requirements.json` | 测试目标、参与角色、业务流程、规则、范围、前置条件、测试数据引用、风险、用户决定和 Requirement Trace。 |
| `test-plan.json` | 当前 Plan Hash、Scenario 引用、能力要求、安全策略、证据策略、恢复策略和审批状态。Run 必须与它一致。 |
| `scenarios/<scenario-id>.json` | 单个 Scenario 的目标、输入、前置条件、详细步骤、预期结果、业务断言、证据、Cleanup、风险和源码引用。 |
| `prd.md` | 面向人的统一文档。前半部分是可审阅的测试计划；Quick Task 完成后，Runtime 会在同一文件追加最新结论、检查结果、Cleanup 和关键截图。QA Agent 标记之外的人工备注会被保留。 |
| `events.jsonl` | 只追加的 Task 审计日志，记录创建、状态流转、计划变化、审批、Run、Source Run 重启、脚本草稿/发布/失效和回归执行。 |
| `memory/` | Task 或 Module 范围的候选知识，例如本次发现的已知问题或观察到的业务规则。候选内容经人工 review 后才能成为长期有效 Memory。 |

### Source Run 文件

每个 Task 只保留一个用于沉淀正式脚本的 `source-run/`：

| 文件或目录 | 用途 |
| --- | --- |
| `source-run/run.json` | 首次真实业务测试的结构化事实，包含环境、Git 状态、真实步骤、定位器、截图引用、断言、Cleanup、恢复过程、结论和 Python 生成资格。 |
| `source-run/report.md` | Runtime 根据 `run.json` 生成的权威报告，包含上下文、步骤、截图、业务断言、缺陷候选、Cleanup 和恢复记录。人工另写的总结不替代它。 |
| `source-run/screenshots/` | Runtime 从宿主工具复制进来的真实截图。UI 步骤以及通过/失败的终态业务断言都必须有对应截图。 |
| `source-run/evidence/` | 按需保存日志、网络结果或其他宿主证据文件。 |

正式 Python 脚本发布前，再次进行首次测试会替换旧的未冻结 Source Run，并在 `events.jsonl` 记录 `source_run_restarted`。正式脚本发布后，Source Run 被冻结，后续执行只能进入 `regression-runs/`。Task 不维护多个 `runs/<run-id>/` 探索历史。

### Python 回归文件

| 文件或目录 | 用途 |
| --- | --- |
| `.runtime/drafts/<session>/<script-id>/draft.json` | Session 范围的脚本草稿清单，记录来源 Run、Plan Hash、步骤、Scenario、Flow Hash 和脚本 Hash。 |
| `.runtime/drafts/<session>/<script-id>/<script-id>.py` | 尚未发布的脚本草稿。它不会参加 Task、Module 或 Release 回归，发布后草稿目录会删除。 |
| `regression/<script-id>.py` | 用户审阅并批准后的正式 Python 回归脚本，固定后续执行顺序。 |
| `regression/<script-id>.json` | 正式脚本清单，记录批准人、脚本状态、来源 Run、来源步骤、Plan/Flow Hash、最近执行和验证状态。 |
| `regression-runs/<pyreg-run-id>/result.json` | 正式脚本写出的结构化业务结果，必须符合 `qa-agent/python-regression-result/v1`。 |
| `regression-runs/<pyreg-run-id>/run.json` | Runtime 对本次脚本执行的封装结果，包括业务状态、合同状态、退出码和所有文件引用。 |
| `regression-runs/<pyreg-run-id>/report.md` | 本次脚本回归的 Runtime 报告。 |
| `stdout.log` / `stderr.log` | Python 进程的标准输出和错误输出，用于排查脚本、Bridge 或环境问题。 |
| `screenshots/` / `evidence/` | 正式脚本本次执行产生的截图和其他证据。 |

TestPlan 改变时，与旧 Plan Hash 绑定的正式脚本会标记为 `stale`，不会继续进入回归选择。重新生成时必须重新完成计划审批、Source Run、脚本草稿审阅和发布批准。

### Session、临时文件和锁

| 文件或目录 | 用途 |
| --- | --- |
| `.runtime/sessions/<session>.json` | 当前对话或窗口绑定的 Module、Task 和 Run 指针，供 `continue` 恢复。 |
| `.runtime/current-task.json` | 未显式提供 Session Key 时的默认兼容指针。 |
| `.runtime/sessions/<session>.closed.json` | `finish` 后生成的会话关闭记录，防止已结束会话被自动重新绑定。 |
| `.runtime/drafts/` | 尚未发布的 Session 脚本草稿，属于临时审核资产。 |
| `.locks/` | 原子写入和并发操作使用的短期锁。正常命令结束后锁文件会自动移除。 |

Session 文件只负责“当前继续哪个 Task”，不是测试事实，也不是 Task 生命周期。删除 Session 指针不会删除 Task、Run、报告或截图。

### Memory、影响分析与发布文件

| 文件或目录 | 用途 |
| --- | --- |
| `modules/<module>/memory/`、`tasks/<task>/memory/`、`shared-memory/entries/` | 不同作用域的候选或已审核知识。失败 Run 可产生 known issue 候选，成功 Run 可产生 observed business rule 候选。 |
| `impact-analysis/<impact-id>.json` | 根据 Git 变更文件、Module 和 Task 映射生成的影响分析，供 Release Regression 选择范围。 |
| `regression-runs/<batch-run-id>.json` | Task、Module 或 Release 多脚本执行的批次结果，只保存汇总与子 Run 引用。 |
| `modules/<module>/reports/<batch-run-id>.md` | Task/Module 批量回归报告。 |
| `release-checks/<release-id>.json` | 发布检查的 Profile、影响分析、脚本选择、资产缺口、阻塞项和 GO/NO-GO 决策。 |
| `reports/<release-id>.md` | 发布 QA 报告。它引用各 Task 的子报告，不重复复制截图和日志。 |

`qa-agent archive` 不会额外创建 Archive 目录，也不会移动上述文件；它在验证全部长期资产后，只把 Task 状态转为 `archived`，原始证据仍保存在 Task 内。

### 宿主集成文件

执行 `qa-agent init --cursor`、`--codex`、`--claude` 等选项时，还会在项目或用户宿主目录生成托管入口。例如 Cursor 会生成 `.cursor/rules/qa-agent.mdc`、`.cursor/commands/qa-agent-cli.md` 和 `.cursor/skills/qa-agent`，Codex/通用 Agent Skills 会使用 `.codex/skills/qa-agent` 或 `.agents/skills/qa-agent`。具体路径取决于宿主和安装 Scope，这些文件由 `qa-agent update` 同步。

v0.3.4 继续采用精简资产模型，不生成重复的 `summary.md`、Quick 观察场景 JSON、Source Run 历史索引或 Session Journal。

## Python 回归脚本

测试完成并生成带截图的报告后，如果 Runtime 判断来源 Run 的步骤、定位器、输入引用、业务断言、截图和 Cleanup 足够稳定，Agent 会询问：

```text
是否根据这次已经跑过的业务流程生成 Python 回归脚本？
```

这里有两个独立确认：

```text
同意生成脚本草稿
≠
批准脚本发布到 Task
```

用户第一次同意后，Agent 根据来源 Run 的实际步骤、最终定位器、输入引用、业务断言、截图节点和 Cleanup 编写 Python 文件，然后保存为 Session 草稿：

```bash
qa-agent regression draft \
  --module <module> \
  --task <task> \
  --run <source-run> \
  --file <temporary-script.py> \
  --id <script-id>
```

草稿保存在：

```text
.qa-agent/.runtime/drafts/<session>/<script-id>/
```

草稿不会加入 Task、正式回归或发布检查。Agent 必须向用户展示完整脚本或完整 Diff，并说明环境变量、Host Bridge、断言、截图和 Cleanup。

用户明确确认脚本没有问题后，才发布：

```bash
qa-agent regression publish \
  --module <module> \
  --task <task> \
  --draft <script-id> \
  --confirmed-by <human>
```

正式资产位于：

```text
.qa-agent/modules/<module>/tasks/<task>/
├── regression/
│   ├── <script-id>.py
│   └── <script-id>.json
└── regression-runs/
    └── <run-id>/
        ├── run.json
        ├── result.json
        ├── report.md
        ├── stdout.log
        ├── stderr.log
        ├── screenshots/
        └── evidence/
```

后续可以从命令行运行：

```bash
qa-agent regression run <script-id> \
  --module <module> \
  --task <task> \
  --bridge '<host bridge command>'
```

Python 脚本决定固定执行顺序，宿主 Bridge 负责真实浏览器、模拟器或设备操作。Runtime 保存结构化结果和报告，Agent 只审视结果、截图、stdout、stderr 和 Cleanup，不重新规划每一步。

脚本合同完整执行时会标记为 `validated`。业务断言即使失败，只要脚本正确执行到断言位置，脚本合同仍可保持有效，业务结果仍记录为 FAIL。

## Session 与继续

`check`、`start`、`review` 和 `test` 会将 Task 绑定到当前 Session。

宿主有稳定窗口或对话 ID 时，可以使用：

```bash
qa-agent continue --session cursor-window-a
```

或：

```bash
export QA_AGENT_SESSION_KEY=cursor-window-a
```

多个窗口可以同时处理不同 Task。没有绑定且只有一个未完成 Task 时，Runtime 会自动恢复；存在多个候选时，Runtime 会要求选择，不会随机继续。

`qa-agent finish` 会关闭当前 Session 并保留 Task 资产。它不会将严格回归 Task 自动归档。

## 严格回归与发布检查

固定测试矩阵、完整发布范围、影响分析、发布前验证、GO/NO-GO 和 Release Gate 继续由主 `qa-agent` 负责，不再加载旧的独立规划 Skill。

这些流程同样必须：

- 生成完整 PlanDraft 和 Task PRD；
- 解决所有 QA 疑问；
- 获取“确认测试方案”；
- 在首次 UI 执行前另行获取“确认开始测试”；
- 保留 Plan Hash、真人审批、Python 脚本审阅、真实执行验证、影响分析、Release Decision 和 Archive Gate。

## 安全边界

Runtime 默认会在以下操作前停止：

- 真实支付或退款；
- 生产数据删除或数据库写入；
- 真实短信、邮件或通知发送；
- 生产权限变更；
- 使用未经批准的生产账号或原始生产数据；
- 缺少工具或系统权限；
- 当前执行与已批准契约不一致。

Agent 不得伪造：

- 截图；
- UI 操作；
- 业务观察；
- Cleanup；
- 审批；
- 回归结果；
- 正式报告。

## 常用命令

默认帮助只展示六个命令：

```bash
qa-agent init
qa-agent check --request TEXT
qa-agent continue
qa-agent finish
qa-agent doctor
qa-agent update --migrate
```

查看高级命令：

```bash
qa-agent help --advanced
```

高级命令包括严格计划、Run 证据写入、Python Regression、Release、Archive、Migration 和验证命令。

## 升级到 v0.3.4

升级 CLI：

```bash
npm install -g qa-agent-skill@0.3.4
```

进入已有项目：

```bash
qa-agent update --migrate --force
```

Migration 会删除旧的中间回放目录和套件文件，将旧 `regression_ready`、`finalizing` 映射到 `reviewing_result`，并为已有 Python 脚本补充 Run 级来源追踪。Run、报告和截图不会丢失。

## 项目验证

```bash
qa-agent doctor
qa-agent validate
```

开发本项目：

```bash
npm install
npm run verify
npm run pack:check
```

`npm run verify` 包含 TypeScript 检查、构建和完整测试。

## 三个 Skill

v0.3.4 安装结构：

```text
qa-agent
qa-agent-guided
qa-agent-regression-test
```

- `qa-agent`：AI 主导测试、PRD 双门禁、严格矩阵与发布计划、结果、Python 草稿与发布；
- `qa-agent-guided`：QA 主导的单步测试，每个操作前批准、操作后判定；
- `qa-agent-regression-test`：只运行 Task 中已批准的 Python 回归脚本，并审视 Runtime 自动生成的回归报告。

Runtime 复杂度仍然保留在内部，但用户只需要关注目标、进度、结果和必要决定。
