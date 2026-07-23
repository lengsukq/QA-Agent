# 生成文件与目录结构

QA Agent 的持久化数据默认位于项目根目录的 `.qa-agent/`。目录采用"项目 → Module → Task → Source Run / Regression Run"的结构。部分目录只有在对应功能首次使用后才会出现。

## 完整目录结构

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

## 项目级文件

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

## Module 与 Task 定义文件

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

## Source Run 文件

每个 Task 只保留一个用于沉淀正式脚本的 `source-run/`：

| 文件或目录 | 用途 |
| --- | --- |
| `source-run/run.json` | 首次真实业务测试的结构化事实，包含环境、Git 状态、真实步骤、定位器、截图引用、断言、Cleanup、恢复过程、结论和 Python 生成资格。 |
| `source-run/report.md` | Runtime 根据 `run.json` 生成的权威报告，包含上下文、步骤、截图、业务断言、缺陷候选、Cleanup 和恢复记录。人工另写的总结不替代它。 |
| `source-run/screenshots/` | Runtime 从宿主工具复制进来的真实截图。UI 步骤以及通过/失败的终态业务断言都必须有对应截图。 |
| `source-run/evidence/` | 按需保存日志、网络结果或其他宿主证据文件。 |

正式 Python 脚本发布前，再次进行首次测试会替换旧的未冻结 Source Run，并在 `events.jsonl` 记录 `source_run_restarted`。正式脚本发布后，Source Run 被冻结，后续执行只能进入 `regression-runs/`。Task 不维护多个 `runs/<run-id>/` 探索历史。

## Python 回归文件

| 文件或目录 | 用途 |
| --- | --- |
| `.runtime/drafts/<session>/<script-id>/draft.json` | Session 范围的脚本草稿清单，记录来源 Run、Plan Hash、步骤、Scenario、Flow Hash 和脚本 Hash。 |
| `.runtime/drafts/<session>/<script-id>/<script-id>.py` | 尚未发布的脚本草稿。它不会参加 Task、Module 或 Release 回归，发布后草稿目录会删除。 |
| `regression/<script-id>.py` | 用户审阅并批准后的正式 Python 回归脚本，固定后续执行顺序。 |
| `regression/<script-id>.json` | 正式脚本清单，记录批准人、脚本状态、来源 Run、来源步骤、Plan/Flow Hash、最近执行和验证状态。 |
| `regression-runs/<pyreg-run-id>/result.json` | 正式脚本写出的结构化业务结果，必须符合 `qa-agent/python-regression-result/v1`。完成态结果必须逐一覆盖 `sourceStepIds`，且每个步骤包含位于 `screenshots/` 下的非空截图；否则运行会被标记为 `invalid_result`。 |
| `regression-runs/<pyreg-run-id>/run.json` | Runtime 对本次脚本执行的封装结果，包括业务状态、合同状态、退出码和所有文件引用。 |
| `regression-runs/<pyreg-run-id>/report.md` | 本次脚本回归的 Runtime 报告。 |
| `stdout.log` / `stderr.log` | Python 进程的标准输出和错误输出，用于排查脚本、Bridge 或环境问题。 |
| `screenshots/` / `evidence/` | 正式脚本本次执行产生的截图和其他证据。每个来源 UI 步骤必须有新的关键节点截图，并在 `result.json` 中引用。 |

TestPlan 改变时，与旧 Plan Hash 绑定的正式脚本会标记为 `stale`，不会继续进入回归选择。重新生成时必须重新完成计划审批、Source Run、脚本草稿审阅和发布批准。

## Session、临时文件和锁

| 文件或目录 | 用途 |
| --- | --- |
| `.runtime/sessions/<session>.json` | 当前对话或窗口绑定的 Module、Task 和 Run 指针，供 `continue` 恢复。 |
| `.runtime/current-task.json` | 未显式提供 Session Key 时的默认兼容指针。 |
| `.runtime/sessions/<session>.closed.json` | `finish` 后生成的会话关闭记录，防止已结束会话被自动重新绑定。 |
| `.runtime/drafts/` | 尚未发布的 Session 脚本草稿，属于临时审核资产。 |
| `.locks/` | 原子写入和并发操作使用的短期锁。正常命令结束后锁文件会自动移除。 |

Session 文件只负责"当前继续哪个 Task"，不是测试事实，也不是 Task 生命周期。删除 Session 指针不会删除 Task、Run、报告或截图。

## Memory、影响分析与发布文件

| 文件或目录 | 用途 |
| --- | --- |
| `modules/<module>/memory/`、`tasks/<task>/memory/`、`shared-memory/entries/` | 不同作用域的候选或已审核知识。失败 Run 可产生 known issue 候选，成功 Run 可产生 observed business rule 候选。 |
| `impact-analysis/<impact-id>.json` | 根据 Git 变更文件、Module 和 Task 映射生成的影响分析，供 Release Regression 选择范围。 |
| `regression-runs/<batch-run-id>.json` | Task、Module 或 Release 多脚本执行的批次结果，只保存汇总与子 Run 引用。 |
| `modules/<module>/reports/<batch-run-id>.md` | Task/Module 批量回归报告。 |
| `release-checks/<release-id>.json` | 发布检查的 Profile、影响分析、脚本选择、资产缺口、阻塞项和 GO/NO-GO 决策。 |
| `reports/<release-id>.md` | 发布 QA 报告。它引用各 Task 的子报告，不重复复制截图和日志。 |

`qa-agent archive` 不会额外创建 Archive 目录，也不会移动上述文件；它在验证全部长期资产后，只把 Task 状态转为 `archived`，原始证据仍保存在 Task 内。

## 宿主集成文件

执行 `qa-agent init --cursor`、`--codex`、`--claude` 等选项时，还会在项目或用户宿主目录生成托管入口。例如 Cursor 会生成 `.cursor/rules/qa-agent.mdc`、`.cursor/commands/qa-agent-cli.md` 和 `.cursor/skills/qa-agent`，Codex/通用 Agent Skills 会使用 `.codex/skills/qa-agent` 或 `.agents/skills/qa-agent`。具体路径取决于宿主和安装 Scope，这些文件由 `qa-agent update` 同步。

v0.3.7 继续采用精简资产模型，不生成重复的 `summary.md`、Quick 观察场景 JSON、Source Run 历史索引或 Session Journal。
