# QA Agent

[English](README.en.md)

AI-powered QA Engineer CLI for business validation and regression testing.

QA Agent 是一个面向真实业务验证和回归测试的 AI QA Agent。

它是一个 CLI-first 的 QA Agent：命令行负责初始化项目、规划 Task、执行 Run、生成报告和回归；Codex、Cursor 等宿主 Skill 负责把宿主能力接入 CLI 工作流。它不是传统测试脚本执行器，而是帮助团队模拟真实 QA 工程师的工作方式：理解项目、分析影响范围、设计测试计划、执行业务流程、验证结果，并持续沉淀回归经验。

## CLI 快速开始

### 从 npm 全局安装 CLI（推荐）

```bash
npm install --global qa-agent-skill
qa-agent --version
qa-agent --help
```

升级到最新版本：

```bash
npm update --global qa-agent-skill
```

卸载：

```bash
npm uninstall --global qa-agent-skill
```

如果 npm 全局目录没有写权限，可以使用项目级安装并通过 `npx` 运行：

```bash
npm install --save-dev qa-agent-skill
npx qa-agent --help
```

从源码使用：

```bash
cd /path/to/QA-Agent
npm install
npm link
qa-agent --help
```

初始化被测项目：

```bash
cd /path/to/your-app
qa-agent init --id my-app --name "My App" --description "业务应用 QA 项目"
qa-agent doctor
```

也可以用一条命令同时初始化项目并把 QA 提示词/Skill 注入宿主：

```bash
# Cursor：写入被测项目的 .cursor/ Rule 和 Command
qa-agent configure \
  --project /path/to/your-app \
  --host cursor \
  --scope project \
  --id my-app \
  --name "My App"

# Codex：安装到当前用户的 Codex Skill 目录，并初始化项目数据
qa-agent configure \
  --project /path/to/your-app \
  --host codex \
  --scope user \
  --id my-app \
  --name "My App"
```

`configure` 只负责项目初始化和宿主注入；后续通过 `qa-agent workflow`、`qa-agent task`、`qa-agent run`、`qa-agent operation` 等命令执行 QA 工作流。

CLI 是执行入口；宿主 Skill 只负责让 Codex、Cursor 等 Agent 知道何时调用哪些 CLI 命令，以及如何使用浏览器、模拟器和其他已批准工具。项目数据、Task、Run、截图和报告始终保存在被测项目的 `.qa-agent/` 内。

## 推荐工作流：start → 对话确认 → test → archive

```bash
qa-agent configure --project /path/to/your-app --host cursor --scope project
qa-agent start --request "验证 Checkout 核心流程" --module checkout --task checkout-basic-flow
# 在 Codex/Cursor 对话中审阅 planHash、Scenario、证据和安全边界，并明确确认
qa-agent test --module checkout --task checkout-basic-flow
# Run 完成并生成 Runtime 报告、截图和 OperationPlan 后：
qa-agent archive --module checkout --task checkout-basic-flow
```

`start` 只负责创建或复用 Module/Task、生成 Task 目录、Test Plan、Scenario 和 TodoList，并停在 `approval_required`；它不会启动浏览器、模拟器或设备。`test` 只执行已确认的 Task，并自动在首次 `explore` 与兼容的 `replay` 之间选择。`archive` 是严格的可回归门禁：它会检查背景、计划、每个 Scenario 的 active OperationPlan、RegressionSuite、Runtime 报告和实际存在的 Markdown 图片证据；失败时不会改变 Task 状态。

`init` 只初始化被测项目的 `.qa-agent/` 运行边界，不注入宿主 Skill。`configure` 负责“一站式”项目初始化和宿主提示词/Skill 注入；已经初始化的 `.qa-agent` 数据不会被覆盖。宿主 Skill 负责对话确认、TodoList 镜像和实际 UI 工具调用，CLI Runtime 负责状态、证据、报告和归档。

兼容旧项目的底层命令仍保留，包括 `workflow bootstrap`、`task explore`、`task run`、`operation replay`、`task review` 和 `task archive`；新项目优先使用上面的语义入口。

## 为什么需要 QA Agent

传统自动化测试通常关注：

- API 是否返回正确
- DOM 是否存在
- 固定脚本是否执行成功

但真实 QA 需要回答：

- 用户实际看到的流程是否正确？
- 业务规则是否符合预期？
- 新代码修改是否影响已有功能？
- 一个失败问题是否可以复现和定位？
- 过去验证过的问题是否可以自动回归？

QA Agent 的目标不是替代 Playwright、Appium 等测试工具，而是提供 AI QA 思考层。

```text
Requirement / Code Change
          |
          v
    Impact Analysis
          |
          v
     Test Planning
          |
          v
   Business Validation
          |
          v
 Evidence + Report
          |
          v
 Regression Memory
```

## 核心模型

QA Agent 使用项目级 QA 生命周期管理测试资产：

```text
Project
  |
  ├── Module
  ├── Test Task
  ├── Scenario
  ├── Test Run
  ├── Evidence
  ├── Report
  └── Regression Memory
```

QA Agent 将这些能力组织为一个可持续使用的项目边界：

```text
Project → Module → Test Task → Scenario → Run → Step / Evidence / Report / Memory
```

- **Project / Module**：保存业务边界、角色、风险和目标。
- **Test Task / Scenario**：保存可审阅的业务验证计划与预期结果。
- **Run**：保存每次真实执行的动作、状态、截图、网络/日志证据和最终结论。
- **Report**：每次执行自动写入 Markdown 测试报告。
- **Memory**：将已确认的业务规则、历史缺陷和回归经验沉淀到 `.qa-agent/`，供后续计划和执行使用。

代码、DOM、网络日志只用于佐证或排障；业务结论以真实界面与可见结果为准。

## 支持的 Agent 宿主

核心运行时与宿主无关。当前提供以下安装适配：

| 宿主 | 集成形式 |
| --- | --- |
| Codex | 原生 Skill |
| Claude Code | 项目级 Skill |
| Cursor | Rule + `/qa-agent` Command |
| OpenCode | 项目级 Skill |
| GitHub Copilot | Skill + Custom Agent |
| Gemini CLI | `/qa-agent` Command |
| 通用兼容宿主 | `.agents/skills/qa-agent` Skill |

宿主负责提供并实际调用浏览器、模拟器、日志、数据库和源码等工具；`qa-agent` 负责统一规划、执行记录、证据、报告和项目记忆。它是 QA 大脑，不是新的浏览器或模拟器框架：真实 Web、Android/iOS 操作必须由宿主 Agent 的已批准 MCP 或本地工具完成，再通过同一套 Run 生命周期保存证据和报告。

## 前置条件

- Node.js `>= 22.6`
- npm
- 对真实 UI 执行，当前 Agent 宿主必须有对应浏览器、模拟器或设备控制能力

## 启动项目

先安装依赖并验证运行时：

```bash
cd /path/to/QA-Agent
npm install
npm test
npm run qa-agent -- help
```

测试覆盖宿主能力快照、步骤和证据导入、视觉业务观察、快速回放、自动报告和跨宿主安装。

## 安装到 Agent 宿主

从本仓库根目录执行。使用 `--scope project` 创建可提交的项目级配置；使用 `--scope user` 安装到当前开发者的用户目录并作用于该宿主的全部项目。未指定时，Codex 默认为 `user`，其他宿主默认为 `project`。

> `--scope user` **只安装 Skill/Rule/Command 的通用说明，绝不存放项目数据**。业务记忆、账号引用、任务、执行记录、截图、证据和报告始终只存放在当前被测项目的 `.qa-agent/` 内；不同项目之间不会读取、合并或推断这些内容。

```bash
# Codex（用户级）
node bin/qa-agent.mjs install-host codex --scope user

# 可提交到仓库的项目级安装
node bin/qa-agent.mjs install-host claude --scope project --project /path/to/your-app
node bin/qa-agent.mjs install-host cursor --scope project --project /path/to/your-app
node bin/qa-agent.mjs install-host opencode --scope project --project /path/to/your-app
node bin/qa-agent.mjs install-host copilot --scope project --project /path/to/your-app
node bin/qa-agent.mjs install-host gemini --scope project --project /path/to/your-app

# 当前开发者所有项目生效的用户级安装
node bin/qa-agent.mjs install-host claude --scope user
node bin/qa-agent.mjs install-host opencode --scope user
node bin/qa-agent.mjs install-host copilot --scope user
node bin/qa-agent.mjs install-host gemini --scope user
node bin/qa-agent.mjs install-host agents --scope user

# 使用通用 Agent Skills 目录的项目级安装
node bin/qa-agent.mjs install-host agents --scope project --project /path/to/your-app
```

如需覆盖已有宿主配置，显式添加 `--force`。Gemini CLI 安装后执行 `/commands reload` 使新命令生效。Cursor 的用户级 Rule 由 **Cursor Settings > Rules** 管理，且该格式是纯文本；因此本 CLI 只自动生成其可版本控制的项目级 Rule 和 Command。Codex 若需要仓库级可共享的 Skill，可使用 `agents --scope project`。

### Codex 安装示例

用户级安装会让当前开发者的所有项目都可以使用 QA-Agent：

```bash
cd /path/to/QA-Agent
npm install
node bin/qa-agent.mjs install-host codex --scope user
```

安装后，在 Codex 中打开被测项目，并在被测项目根目录初始化 QA-Agent 数据边界：

```bash
cd /path/to/your-app
node /path/to/QA-Agent/bin/qa-agent.mjs init \
  --id my-app \
  --name "My App" \
  --description "业务应用 QA 项目"
node /path/to/QA-Agent/bin/qa-agent.mjs doctor
```

如果希望把 Skill 随被测项目提交到仓库，使用项目级通用 Agent Skills 安装：

```bash
cd /path/to/QA-Agent
node bin/qa-agent.mjs install-host agents --scope project --project /path/to/your-app
```

验证 Codex 项目级文件：`/path/to/your-app/.agents/skills/qa-agent/SKILL.md`。

### Cursor 安装示例

Cursor 使用项目级 Rule 和 Command。进入 QA-Agent 仓库执行：

```bash
cd /path/to/QA-Agent
npm install
node bin/qa-agent.mjs install-host cursor \
  --scope project \
  --project /path/to/your-app
```

然后用 Cursor 打开 `/path/to/your-app`，确认以下文件已生成：

```text
/path/to/your-app/.cursor/rules/qa-agent.mdc
/path/to/your-app/.cursor/commands/qa-agent.md
```

在 Cursor 中执行 `/qa-agent` 开始 QA 工作流。首次使用仍需在被测项目中初始化：

```bash
cd /path/to/your-app
node /path/to/QA-Agent/bin/qa-agent.mjs init --id my-app --name "My App"
node /path/to/QA-Agent/bin/qa-agent.mjs doctor
```

Cursor 的用户级 Rule 需要在 **Cursor Settings > Rules** 中手动管理；本 CLI 只生成可提交到项目的 Rule 和 Command。

旧命令 `install-skill` 仍保留，等价于 Codex 安装：

```bash
node bin/qa-agent.mjs install-skill
```

## 初始化被测项目

每个业务项目必须各自初始化一次；所有项目记忆、证据和报告都保留在该项目的 `.qa-agent/` 内。

```bash
cd /path/to/your-app
node /path/to/QA-Agent/bin/qa-agent.mjs init \
  --id my-app \
  --name "My App" \
  --description "业务应用 QA 项目"

node /path/to/QA-Agent/bin/qa-agent.mjs doctor
```

初始化后会生成：

```text
.qa-agent/
├── modules/          # 模块资产；每个 Task 自己保存运行、证据、报告和记忆
├── index/            # 项目级搜索/索引投影（包含 runs.jsonl）
├── regression-runs/  # 跨 Task / Module 套件编排记录
├── shared-memory/    # 已审核的项目知识
├── policies.json     # 安全策略
└── mcp.json           # 宿主工具能力快照与健康状态
```

## 推荐工作流

以下示例将 `qa-agent` 视为已加入 `PATH` 的命令。开发本仓库时可把每个 `qa-agent` 替换为 `node /path/to/QA-Agent/bin/qa-agent.mjs`，或执行 `npm link` 后再使用短命令。

### QA Agent 主闭环

```text
读取当前项目记忆与 Module
  → 使用只读源码/MCP 理解路由、接口、权限与状态（仅作为推断性上下文）
  → 生成包含业务逻辑的测试用例
  → 用户确认当前计划版本
  → 宿主 Agent 通过 Browser / Mobile MCP 操作真实业务流程
  → 每个关键状态和断言截图、记录预期与实际
  → 基于真实界面结果判断 PASS / FAIL / BLOCKED 等结论
  → 自动生成含图片的报告
  → 生成 observed 业务规则或 known_issue 候选记忆
  → 用户审核后沉淀为当前项目正式知识
```

源码可以帮助发现待验证规则和定位问题，但不能代替真实业务验证；候选记忆永远先进入当前项目的审核队列，不会自动成为跨项目或全局知识。

### 1. 使用 Workflow Bootstrap 创建 Task 和计划

每次新的 QA 请求都先进入 Bootstrap。宿主应把返回的 `todoList` 同步到 IDE TodoList；在返回 `uiExecutionAllowed: true`、`mustStop: false` 和 `runId` 之前，禁止调用浏览器、模拟器或设备工具。Bootstrap 会立即创建并返回 `bootstrap.taskDirectory` 与 `bootstrap.taskAssets`。

```bash
qa-agent workflow bootstrap \
  --request "验证用户可以查看并提交正确的结算信息" \
  --module checkout \
  --task checkout-basic-flow \
  --module-name "结算" \
  --task-name "基础结算流程" \
  --platforms web \
  --risk high
```

首次返回类似：

```json
{
  "workflowStatus": "approval_required",
  "uiExecutionAllowed": false,
  "mustStop": true,
  "manualReportAllowed": false,
  "taskDirectory": ".qa-agent/modules/checkout/tasks/checkout-basic-flow",
  "bootstrap": { "taskCreated": true, "taskAssets": [] },
  "todoList": [],
  "plan": {}
}
```

宿主可以在此阶段只读分析源码以完善计划，然后向用户展示当前 `plan` 和 `planHash`。任何 UI 操作之前必须由真实用户审批：

```bash
qa-agent task review checkout-basic-flow \
  --module checkout \
  --approve \
  --confirmed-by "qa-reviewer"
```

审批后仍需验证宿主能力。只有 `task explore` 返回正式门禁字段后才可开始 UI 操作：

```bash
qa-agent task explore checkout-basic-flow --module checkout
```

```json
{
  "uiExecutionAllowed": true,
  "mustStop": false,
  "manualReportAllowed": false,
  "runId": "run-...",
  "workflow": { "workflowStatus": "running" }
}
```

计划、审批、能力或 Prompt Bundle 不满足时，返回 `uiExecutionAllowed: false` 和 `mustStop: true`。宿主必须停止 UI 操作，禁止另写 PASS 报告。

### 2. 导入宿主能力快照

宿主 Agent 在开始前确认其已连接的工具和系统权限，并把快照导入当前项目。`qa-agent` 不连接 MCP，也不自行验证权限。

```json
{
  "host": "codex",
  "connections": [
    {
      "id": "browser-mcp",
      "status": "available",
      "capabilities": ["browser.interact", "browser.inspect", "logs.read"],
      "permissionStatus": "verified"
    }
  ]
}
```

```bash
qa-agent host attest --id browser-mcp \
  --capabilities browser.interact,browser.inspect \
  --permission-status verified \
  --host cursor

# 或导入完整快照
qa-agent host import --file /absolute/path/host-capabilities.json
```

### 3. 使用 Agent-guided 真实业务验证

这是推荐的业务 QA 方式。运行时使用 `qa-agent/v2` 数据协议。宿主 Agent 应自行打开真实页面/模拟器，观察当前界面后决定下一步；每个真实 UI 操作后都保存截图，但只在关键业务断言、金额/权限/状态变化、异常页面、定位器适配和最终状态调用视觉识别。报告会明确区分“Screenshot captured”“Visual inspection performed”“Visual inspection not required”。不要让用户手工点击、截图、判定结果或整理报告。

Agent 在后台通过以下命令持久化真实执行轨迹：

```bash
qa-agent context module checkout
qa-agent task explore checkout-basic-flow --module checkout
qa-agent run step <run-id> --action "打开结算页" --detail "已进入真实结算页面" --screenshot /absolute/path/checkout-open.png --visual-inspection not-required
qa-agent run evidence <run-id> --type console --summary "宿主浏览器控制台输出" --file /absolute/path/console.log
qa-agent run observe <run-id> \
  --scenario happy-path \
  --assertion business-outcome \
  --expected "订单总额、地址和提交入口正确显示" \
  --actual "页面显示订单总额 ¥199.00、默认地址和提交按钮" \
  --status passed \
  --screenshot /absolute/path/checkout-result.png
qa-agent run complete <run-id>
```

`run complete` 会先执行严格收尾检查：每个已选 Scenario 的每个 `visualAssertions` 都必须已有对应的 `run observe`。普通 `run step` 即使状态为 PASSED、甚至使用 `operationAction=assert`，也不能替代业务断言。缺少断言时完成命令会被拒绝，Run 保持 `running`，补齐观察后可以再次完成。检查通过后才写入 `runs/<run-id>/report.md`，并更新 `runs/index.json` 与 `runs/latest.json`。正式报告包含 Runtime ownership marker、Run ID、证据数量和关键节点内嵌截图；`.qa-agent/reports/<name>.md` 与 `Task/reports/` 不属于正式 Task 报告。

首次成功运行还会检查 OperationPlan 的可回放质量。`navigate/click/input/fill` 需要明确的操作类型和定位器，`input/fill` 还需要结构化且脱敏的 `inputRefs`。业务验证可以 PASS，但如果这些字段不完整，报告会输出 `OperationPlan 未生成原因`，而不会生成不可稳定回放的 JSON。旧项目可运行 `qa-agent prompts sync` 更新 `.qa-agent/prompts/`。

升级已有项目时，先运行 `qa-agent migrate` 将旧 `Task/reports/` 迁移到 `runs/<run-id>/report.md`，并将无法绑定 Run 的手写报告保留到 `.qa-agent/orphans/reports/`；再运行 `qa-agent prompts sync`。旧版审批没有 `confirmationSource`，需要由真实审核人重新执行 `task review --approve --confirmed-by <reviewer>`；`qa-agent`、`assistant`、`system` 等自动身份不能审批自己的计划。创建或修改状态的 Scenario 应声明 Cleanup，并在完成前使用 `run cleanup` 记录结果。人工操作系统 Picker 等步骤应使用 `--execution-mode user-assisted`，此类证据可用于业务结论，但不会生成全自动 OperationPlan。

每个 Task 是一个自包含测试资产目录：

```text
.qa-agent/modules/<module>/tasks/<task>/
├── task.json
├── module-snapshot.json
├── requirements.json
├── test-plan.json
├── scenarios/
├── operation-plans/
├── regression-suite.json
├── runs/
│   ├── index.json
│   ├── latest.json
│   └── <run-id>/
│       ├── run.json
│       ├── report.md
│       ├── screenshots/
│       └── evidence/
└── memory/
```

### 4. 快速回归执行模式

首次 Explore 通过并审核 OperationPlan 后，后续不重新规划或审查源码，直接执行 JSON：

```bash
qa-agent operation replay OPERATION_ID \
  --module checkout \
  --task checkout-basic-flow
```

返回结果包含完整 `operationPlan`、`nextOperationStep`、`remainingOperationSteps` 和 `checkpoints`。宿主严格按顺序执行；每次 Replay 都创建新的 Run、报告和关键节点截图。


首次成功运行后，Agent 会在任务目录生成候选 OperationPlan：`.qa-agent/modules/<module>/tasks/<task>/operation-plans/<scenario>/`。审核后可快速回放同一业务流程：

```bash
qa-agent task operation list checkout-basic-flow --module checkout
qa-agent task operation review checkout-basic-flow --module checkout --operation OPERATION_ID --approve
qa-agent task run checkout-basic-flow --module checkout --operation OPERATION_ID
qa-agent run recover <run-id> --reason "元素尚未出现" --action wait --detail "元素出现后继续" --outcome continued
qa-agent task regression sync checkout-basic-flow --module checkout
qa-agent task regression run checkout-basic-flow --module checkout
qa-agent module regression run checkout
```

只有 Task 计划哈希、用户确认、active OperationPlan、平台/设备/App 或 Web 版本、环境/角色、测试数据、所需 MCP 和 macOS 权限都兼容时才会回放；否则回到计划确认或能力接入。回放不跳过业务断言，只跳过重复探索。结果为 `PASS`、`FAIL`、`ADAPTED`、`BLOCKED` 或 `NEEDS_CONFIRMATION`。安全恢复只能使用 `wait`、`refresh`、`back`、`restart-app`、`reset-sandbox-data`、`reconnect-mcp`、`fallback-locator` 或 `resume-checkpoint`，不能改代码、绕过权限或伪造结果。

OperationPlan 按 Scenario 独立保存，步骤包含操作类型、主/备用定位器、输入引用、前置条件、预期状态、断言引用、截图策略、视觉识别策略、风险动作和 checkpoint。回放时每个 `run step` 必须引用下一个 `operationStepId`，不能跳步或重复提交。

Task 级 RegressionSuite 组织一个 Task 的所有 active OperationPlan；Module 回归在启动时从各 Task 的 active OperationPlan 动态聚合，不再保存第二份 Module Suite。模块回归会串行自动执行所有独立流程，单个业务失败后继续其他流程，最后生成模块汇总报告。`run.json` 是结果记录，OperationPlan 才是可执行操作定义。

### 5. 发布前快速回归

先把核心端到端流程标记为 Golden Path / Release Gate：

```bash
qa-agent task update buyer-purchase --module checkout --golden-path --estimated-minutes 8
```

查看代码变化影响和预计执行范围：

```bash
qa-agent impact analyze --base origin/main --head HEAD
qa-agent release check --profile fast --base origin/main --head HEAD --plan-only
```

直接启动发布回归：

```bash
qa-agent release check --profile fast --base origin/main --head HEAD
# 宿主 Agent 自动完成返回的各个 child Run
qa-agent release complete RELEASE_CHECK_ID
```

回归档位：

- `fast`：全局 Release Gate、Golden Path、`every-release` Task，以及受影响的 P0 流程。
- `normal`：在 fast 基础上扩展到受影响的 P1 流程。
- `full`：执行所有已审核且 active 的 OperationPlan。

ImpactAnalysis 会结合 Module id、source hints、entry points、依赖关系和 Task triggers 选择范围，并保留未匹配文件与选择理由。ReleaseCheck 最终输出 `GO`、`NO-GO` 或 `REVIEW`，发布报告位于 `.qa-agent/reports/<release-check-id>.md`，其中引用各 Task 报告及其截图证据，不重复复制全部图片。

### APP / 模拟器测试

初始化或创建模块时声明平台：

```bash
qa-agent init --id my-app --name "My App" --platforms android,ios
qa-agent module create checkout --name "结算" --platforms android
```

开始 APP 测试前，运行时会强制检查 Android 的 `android.adb` 与 `android.screenshot`，或 iOS 的 `ios.simulator.interact` 与 `ios.screenshot`。如果缺失，Run 会被标记为 `BLOCKED`，并提示 Agent 向用户请求批准连接/安装最小权限的 Android Emulator/ADB 或 iOS Simulator/Appium MCP；不会自动安装。

在 macOS 上还需要宿主应用获得 **Screen Recording**（截图/视觉证据）和 **Accessibility**（点击、输入、模拟器控制）权限；iOS 模拟器按需开启 Developer Mode/自动化权限。Agent 不能代替用户授予系统权限；`host doctor --platform` 根据宿主导入的快照输出所需权限、验证步骤和 System Settings → Privacy & Security 路径。

获得用户批准并连接后，由宿主导出最新能力快照：

```bash
qa-agent host import --file /absolute/path/android-host-capabilities.json
qa-agent host doctor --platform android
```

随后由宿主 Agent 操作模拟器，保存每个真实操作的截图，并通过 Agent-guided Run 自动输出报告；普通截图只作为证据，不会强制逐张调用视觉模型。

## 自动报告与经验沉淀

每次运行结束后会产生 Markdown 报告，包含：

- 环境、平台、角色与 Git 状态
- 场景和步骤执行结果
- 预期结果、真实渲染结果和视觉验证结论
- 截图、trace、控制台与网络等证据路径；截图会以 Markdown 图片嵌入报告
- 被阻塞/暂停的原因及恢复条件
- 失败运行形成的待审核项目记忆候选项
- 通过且有视觉证据的运行自动形成 `observed` 业务结果候选记忆；审核后才能成为正式规则
- 基于失败证据生成的缺陷候选、分类与发布决策建议

将确认过的业务规则或回归经验保存为项目记忆：

```bash
qa-agent memory add checkout-total-rule \
  --module checkout \
  --title "结算总额规则" \
  --content "用户确认订单前必须能看到商品金额、运费、优惠和应付总额。"

qa-agent memory review checkout-total-rule --module checkout --approve
```

后续执行 `qa-agent context module checkout` 时，Agent 会同时读取模块、任务、已确认记忆、能力和安全策略。

## 安全边界

默认启用安全模式：

- 在真实支付、退款、删除、通知发送和生产权限变更前停止。
- 默认只读访问源代码和数据源；不修改代码、不提交 Git、不改变生产配置。
- 不将密码、Token、Cookie、私钥、支付信息或未脱敏生产数据写入任务、报告、截图索引或项目记忆。
- 缺失能力、凭据或必要授权时，运行应标记为 `blocked` 或 `paused`，不能伪造通过。

安全规则位于 `.qa-agent/policies.json`，可按项目调整。

## 常用命令

```bash
qa-agent doctor
qa-agent host list
qa-agent context module <module-id>
qa-agent module coverage <module-id>
qa-agent task list
qa-agent run show <run-id>
qa-agent run report <run-id>
qa-agent memory list
```

查看完整命令：

```bash
qa-agent help
```

## 开发与验证

```bash
npm test
npm run qa-agent -- skill validate
npm pack --dry-run
```

当前测试覆盖项目初始化、模块规划、任务审批、MCP 能力声明、浏览器 Runbook 执行、截图/trace 证据、视觉业务观察、自动报告、项目记忆审阅和跨宿主安装。
