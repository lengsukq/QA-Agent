# QA Agent

QA Agent 是一个项目级 AI 测试运行时。它让开发者直接用自然语言发起真实 UI 检查，同时自动保存 Task、Run、截图、业务观察、Cleanup 和测试报告。

当前版本：**v0.3.0**

v0.3.0 将 Python 脚本生成和回归执行进一步拆开：

- Agent 先展示简短业务测试流程，用户同意后才执行真实 UI；
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
0.3.0
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

## 最简单的使用方式

在 Agent 对话中直接说：

```text
帮我测试登录流程。
```

Agent 会按以下顺序工作：

1. 阅读相关源码、路由、测试和配置；
2. 向用户展示简短的业务测试流程；
3. 用户确认流程后，创建或复用 Quick Task；
4. 检查浏览器、模拟器或设备能力；
5. 执行真实 UI 操作；
6. 保存截图和业务观察；
7. 执行 Cleanup；
8. 生成 Runtime Report；
9. 自动更新 Task PRD；
10. 返回简洁结果；
11. 流程适合重复执行时，询问是否生成 Python 回归脚本。

测试被打断后，只需要说：

```text
继续。
```

结束当前测试会话时说：

```text
结束这个测试。
```

用户不需要知道 Module ID、Task ID、Run ID、Plan Hash 或内部 Gate。

## Quick Check

CLI 也可以直接使用：

```bash
qa-agent check "测试登录流程"
```

兼容写法：

```bash
qa-agent check --request "测试登录流程"
```

后续继续：

```bash
qa-agent continue
```

结束会话：

```bash
qa-agent finish
```

Quick Check 不要求完整 TestPlan 审批，但仍然遵守：

- 副作用确认；
- Capability 和权限检查；
- 截图和业务断言要求；
- Cleanup；
- Runtime-owned 报告；
- 禁止真实支付、退款、生产写入等安全策略。

## Quick Task 最终资产

成功完成后，核心资产为：

```text
.qa-agent/modules/<module>/tasks/<task>/
├── task.json
├── prd.md
├── requirements.json
├── test-plan.json
├── scenarios/
└── runs/
    └── <run-id>/
        ├── run.json
        ├── report.md
        ├── screenshots/
        └── evidence/
```

其中：

- `run.json`：单次执行的结构化事实；
- `report.md`：单次 Run 的权威报告；
- `prd.md`：Task 的长期目标与最新结果；
- `screenshots/`：真实截图；
- `evidence/`：其他证据。

v0.3.0 延续精简资产模型，不生成重复的 `summary.md`、Quick 观察场景 JSON 或 Session Journal。

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

## 升级到 v0.3.0

升级 CLI：

```bash
npm install -g qa-agent-skill@0.3.0
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

v0.3.0 安装结构：

```text
qa-agent
qa-agent-plan
qa-agent-regression-test
```

- `qa-agent`：普通测试、继续、恢复、结果、Python 脚本草稿与发布，以及严格 Runtime 执行；
- `qa-agent-plan`：严格回归或发布计划及真人审批；
- `qa-agent-regression-test`：只运行 Task 中已批准的 Python 回归脚本，并审视 Runtime 自动生成的回归报告。

Runtime 复杂度仍然保留在内部，但用户只需要关注目标、进度、结果和必要决定。
