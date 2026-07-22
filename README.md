# QA Agent

QA Agent 是一个项目级 AI 测试运行时。它让开发者直接用自然语言发起真实 UI 检查，同时自动保存 Task、Run、截图、业务观察、Cleanup 和测试报告。

当前版本：**v0.3.3**

v0.3.3 将 Python 脚本生成和回归执行进一步拆开：

- Agent 先创建 Task，再根据源码逐步生成包含“步骤、操作、预期结果”的详细测试计划；
- Runtime 将完整计划写入对应 Task 的 `prd.md`，用户审阅后必须明确回复“确认开始测试”；
- 在精确确认前，Runtime 不创建 Run，Agent 也不得调用任何 UI 测试工具；
- Runtime 生成带截图的正式报告；
- 测试完成后，Agent 可询问是否根据已经跑过的流程生成 Python 脚本；
- 第一次确认只允许生成临时草稿；
- 用户查看完整脚本或 Diff 后，需要第二次明确批准才能发布到 Task；
- 脚本草稿与发布仍由主 `qa-agent` 负责；
- 独立的 `qa-agent-regression-test` 只运行已经发布的脚本，并审视 Runtime 自动生成的回归报告；
- 普通测试仍默认走 Quick Check，安装 Skill 仍保持 3 个；
- 安全门禁、真实证据、严格 Release Check 和 Archive 能力全部保留。

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
0.3.3
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

普通使用时，用户只需要在 Agent 对话中描述目标，例如：

```text
帮我测试登录流程。
```

QA Agent 当前实际执行的是以下流程。

### 1. 创建或恢复 Task

普通请求默认进入 Quick Check，Agent 调用 `qa-agent check`：

- 创建或复用 Module 与 Task；
- 将 Task 绑定到当前 Session；
- 生成初始 `task.json`、`requirements.json`、`test-plan.json`、`prd.md` 和 Scenario 文件；
- Task 进入 `planning`，但此时**不会创建 Run，也不允许操作浏览器、模拟器或设备**。

需要固定完整测试矩阵、发布范围或 GO/NO-GO 时，使用 `qa-agent-plan` 和严格 Task。Quick 与严格 Task 的计划内容可以不同，但后续审批门禁相同。

### 2. 阅读项目并生成详细计划

Agent 阅读与请求相关的源码、路由、页面、状态管理、测试、配置和已有 QA 资产，然后生成结构化 PlanDraft。每个 Scenario 必须明确：

- 测试目标、前置条件、输入和预期业务结果；
- 按顺序执行的步骤；
- 每一步的“操作”和“预期结果”；
- 业务/视觉断言、截图要求和 Cleanup；
- 风险、优先级、需求与源码引用。

Agent 通过 `qa-agent plan apply` 应用计划。Runtime 会拆分保存 Scenario 和 Requirements，并把完整计划更新到 Task 的 `prd.md`。计划变化会使旧审批失效；与旧计划绑定的正式 Python 脚本会变为 `stale`。

### 3. 用户审阅并明确批准

Agent 必须展示当前 Task PRD。用户确认计划无误后，需要明确回复：

```text
确认开始测试
```

`可以`、`继续`、`没问题` 等回复都不算开始授权。Agent 使用 `qa-agent review` 保存真人审批、审批人、确认文本和当前 Plan Hash。PRD 缺失、PRD 已过期、Scenario 没有详细步骤或计划已变化时，审批会被拒绝。

### 4. 执行预检并启动 Source Run

审批通过后，Agent 调用 `qa-agent test`。Runtime 会检查：

- 当前审批是否仍与 TestPlan 一致；
- 浏览器、模拟器、设备和 Host Bridge 能力；
- Android/iOS 所需系统权限；
- 环境、角色、测试数据和安全策略。

预检通过后，Task 的唯一 Source Run 进入 `running`，Runtime 返回 `runId` 和 `uiExecutionAllowed=true`，Agent 才能调用 UI 工具。预检失败时会保存 BLOCKED 结果和报告，但不会执行真实 UI 操作。

### 5. 执行真实操作并持续落盘

执行期间，Agent 必须通过 Runtime 记录：

- 每一个真实 UI 操作、最终定位器、输入引用、预期状态和实际状态；
- 每一步对应的真实截图；
- 每个已声明业务断言的 expected、actual、状态和截图；
- Cleanup 的执行结果；
- 额外日志、网络结果或其他 Evidence；
- 有限次数的恢复尝试及其结果。

单个非核心步骤失败可以记录为失败、阻塞、暂停或适配，并按恢复策略继续其他独立步骤；Agent 不得跳过声明的业务断言，也不得伪造截图、操作或结果。

### 6. 完成 Run 并生成结果

只有所有选中 Scenario 的断言和 Cleanup 都有终态记录后，`qa-agent run complete` 才会成功。Runtime 随后：

1. 计算 Scenario 与整体业务结果；
2. 保存 `source-run/run.json`；
3. 生成权威的 `source-run/report.md`；
4. 保存截图、Evidence、恢复记录和候选项目记忆；
5. 评估该流程是否具备生成 Python 回归脚本的条件。

Quick Task 会自动把最新结果和关键截图写回同一个 `prd.md`，并进入 `completed`。严格 Task 保留结果供后续审阅、回归和 Archive Gate 使用，不会因为结束 Session 而自动归档。

### 7. 可选：沉淀为 Python 回归

只有成功或适配完成的 Source Run，并且具备稳定定位器、结构化输入、逐步截图、完整断言和 Cleanup 时，Runtime 才会标记为可生成脚本。

这里有两次独立批准：

1. 用户同意生成 Session 草稿；
2. 用户查看完整脚本或 Diff 后，单独批准发布到 Task。

发布后的脚本先是 `approved_unverified`。至少成功完成一次脚本执行合同后才会成为 `validated`，并可被 Task、Module 和 Release 回归选择。真实业务断言失败不等于脚本合同无效：脚本正确执行到断言并输出合法结果时，可以同时记录“业务 FAIL”和“脚本合同 completed”。

### 8. 继续、结束与归档

- `qa-agent continue`：读取 Session 和持久化状态，继续当前允许的下一步；没有绑定且只有一个未完成 Task 时会自动恢复，存在多个候选时要求选择。
- `qa-agent finish`：结束当前 Session。运行中的 Run 不能直接结束；Quick Task 必须先完成报告和 PRD 收口；严格 Task 会保留在当前状态。
- `qa-agent archive`：不是移动文件，而是在所有长期资产门禁通过后把 Task 状态改为 `archived`。它要求当前审批、成功 Source Run、截图与报告、覆盖全部 Scenario 的 validated Python 脚本、对应回归执行合同以及无待处理的已知问题候选。

测试中断后，用户通常只需要说：

```text
继续。
```

结束当前测试会话时说：

```text
结束这个测试。
```

用户通常不需要知道 Module ID、Task ID、Run ID、Plan Hash 或内部 Gate。

### 9. 升级与维护

- `qa-agent update`：同步当前版本的 Schema、内置 Runtime Skill 和已配置宿主的托管文件，并更新 `.qa-agent/.version`。
- `qa-agent update --migrate`：先迁移旧结构和旧状态，再更新宿主集成；不会删除有效的 Run、报告和截图。
- `qa-agent index rebuild`：根据权威资产重建 Module、Task、Memory 和 Skill 索引。
- `qa-agent validate`：验证目录、引用、状态、报告归属、脚本合同和敏感信息规则。

## Quick Check

CLI 也可以直接使用：

```bash
qa-agent check "测试登录流程"
```

兼容写法：

```bash
qa-agent check --request "测试登录流程"
```

`check` 只创建 Task 和审阅用 PRD，不会启动测试。Agent 根据源码完善详细步骤后，用户审阅 `prd.md` 并明确回复：

```text
确认开始测试
```

然后记录确认并启动：

```bash
qa-agent review \
  --module MODULE \
  --task TASK \
  --approve \
  --confirmed-by USER \
  --confirmation-text "确认开始测试"

qa-agent test --module MODULE --task TASK
```

在这句精确确认出现前，`qa-agent test` 会失败且不会创建 Run。

后续继续：

```bash
qa-agent continue
```

结束会话：

```bash
qa-agent finish
```

Quick Check 仍保持轻量，但现在同样要求审阅详细 TestPlan 和 Task PRD，并明确回复“确认开始测试”。它同时遵守：

- 当前 PRD 与 Plan Hash 一致；
- 精确的真人开始确认；
- Capability 和权限检查；
- 截图和业务断言要求；
- Cleanup；
- Runtime-owned 报告；
- 禁止真实支付、退款、生产写入等安全策略。

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

v0.3.3 继续采用精简资产模型，不生成重复的 `summary.md`、Quick 观察场景 JSON、Source Run 历史索引或 Session Journal。

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

只有以下请求才进入严格计划流程：

- 在执行前固定并审核完整测试矩阵；
- 需要固定并审批完整发布测试范围；
- 发布前验证；
- GO/NO-GO；
- Release Gate。

宿主会加载：

```text
qa-agent-plan
```

完成严格计划和真人审批后，首次业务测试仍由主 `qa-agent` 执行；后续 Task、Module 和 Release 回归直接选择已验证的 Python 脚本。

严格流程保留：

- PlanDraft；
- 真人 TestPlan 审批；
- Plan Hash；
- 用户审阅的 Python 脚本；
- Python 脚本真实执行验证；
- Task、Module 和 Release 脚本选择；
- 影响分析；
- Release GO/NO-GO；
- Archive Gate。

这些协议默认隐藏，不会出现在普通 Quick Check 的用户回复中。

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

## 升级到 v0.3.3

升级 CLI：

```bash
npm install -g qa-agent-skill@0.3.3
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

v0.3.3 安装结构：

```text
qa-agent
qa-agent-plan
qa-agent-regression-test
```

- `qa-agent`：普通测试、继续、恢复、结果、Python 脚本草稿与发布，以及严格 Runtime 执行；
- `qa-agent-plan`：严格回归或发布计划及真人审批；
- `qa-agent-regression-test`：只运行 Task 中已批准的 Python 回归脚本，并审视 Runtime 自动生成的回归报告。

Runtime 复杂度仍然保留在内部，但用户只需要关注目标、进度、结果和必要决定。
