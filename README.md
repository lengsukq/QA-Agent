# QA Agent Skill

[English](README.en.md)

一个面向真实业务验证的本地优先 QA Agent 运行时与跨宿主 Skill 包。

它不是只把既有测试用例跑一遍的工具。它的目标是让 Agent 像项目 QA 一样：理解业务模块与角色、规划覆盖面、操作真实浏览器或模拟器、依据渲染结果验证业务逻辑、自动保存截图和证据、生成测试报告，并把经过审核的经验沉淀为项目记忆。

## 解决的问题

传统自动化通常只断言 DOM、接口或固定脚本是否成功；而真实 QA 还需要判断用户实际看到了什么、流程是否符合业务规则、异常状态是否可理解，以及失败时是否有可复查的证据。

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
cd /Users/leo/Documents/code/QA-Agent
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

旧命令 `install-skill` 仍保留，等价于 Codex 安装：

```bash
node bin/qa-agent.mjs install-skill
```

## 初始化被测项目

每个业务项目必须各自初始化一次；所有项目记忆、证据和报告都保留在该项目的 `.qa-agent/` 内。

```bash
cd /path/to/your-app
node /Users/leo/Documents/code/QA-Agent/bin/qa-agent.mjs init \
  --id my-app \
  --name "My App" \
  --description "业务应用 QA 项目"

node /Users/leo/Documents/code/QA-Agent/bin/qa-agent.mjs doctor
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

以下示例将 `qa-agent` 视为已加入 `PATH` 的命令。开发本仓库时可把每个 `qa-agent` 替换为 `node /Users/leo/Documents/code/QA-Agent/bin/qa-agent.mjs`，或执行 `npm link` 后再使用短命令。

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

### 1. 建立业务模块与测试任务

```bash
qa-agent module create checkout \
  --name "结算" \
  --description "用户确认商品、价格和配送信息后完成结算" \
  --risk high

qa-agent module plan checkout
qa-agent task create checkout-basic-flow --module checkout
qa-agent task plan checkout-basic-flow --module checkout
```

模块规划会提示核心路径、边界、角色/权限、状态迁移、异常、幂等性、跨模块依赖和历史回归等覆盖维度。`task plan` 会输出可给用户确认的测试用例，包括业务目标/规则、前置条件、测试数据、场景、预期结果、视觉断言和证据。

生成新用例前，宿主 Agent 可以用已批准的只读源码/MCP 能力了解路由、组件、接口、权限和状态流转，并将其作为**推断性的规划上下文**；源码本身不能证明业务正确，最终结论仍必须来自真实运行证据。

**任何浏览器或 APP 操作之前，必须先由用户确认测试用例和业务逻辑。** 确认后记录确认人并将任务标记为可运行：

```bash
qa-agent task review checkout-basic-flow --module checkout --approve --confirmed-by "leo"
```

确认会绑定当前测试计划的哈希。后续如果修改业务逻辑、预期结果、OperationPlan、测试数据、能力或安全边界，旧确认会自动失效，任务回到 `needs_review`；只有未变更的已确认计划才可重复自动回归运行。

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
qa-agent host import --file /absolute/path/host-capabilities.json
```

### 3. 使用 Agent-guided 真实业务验证

这是推荐的业务 QA 方式。运行时使用 `qa-agent/v2` 数据协议。宿主 Agent 应自行打开真实页面/模拟器，观察当前界面后决定下一步；每个真实 UI 操作后都保存截图，但只在关键业务断言、金额/权限/状态变化、异常页面、定位器适配和最终状态调用视觉识别。报告会明确区分“Screenshot captured”“Visual inspection performed”“Visual inspection not required”。不要让用户手工点击、截图、判定结果或整理报告。

Agent 在后台通过以下命令持久化真实执行轨迹：

```bash
qa-agent context module checkout
qa-agent task run checkout-basic-flow --module checkout
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

`run complete` 会自动写入当前 Task 的 `reports/<run-id>.md`，并更新 `reports/index.json` 与 `reports/latest.json`。每项视觉业务结论都必须关联截图；缺少视觉证据不能被标记为通过。

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
├── runs/<run-id>/
├── reports/
└── memory/
```

### 4. 快速回归执行模式

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
