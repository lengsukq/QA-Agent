# QA Agent

QA Agent 是一个项目级 AI 测试运行时。它让开发者直接用自然语言发起真实 UI 检查，同时自动保存 Task、Run、截图、业务观察、Cleanup 和测试报告。

当前版本：**v0.3.7**（[变更说明](skill/qa-agent/references/changelog.md)）

## 适合解决什么问题

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

```bash
npm install -g qa-agent-skill
qa-agent --version   # 应输出 0.3.7
```

进入被测项目并初始化，同时配置宿主（可多选）：

```bash
cd /path/to/project
qa-agent init --cursor --codex --claude
```

支持的宿主 flag：`--cursor`、`--codex`、`--claude`、`--copilot`、`--gemini`、`--opencode`、`--agents`。

初始化后运行 Doctor 检查能力是否就绪：

```bash
qa-agent doctor
```

Doctor 会检查项目初始化完整性、宿主与浏览器/模拟器/设备能力，以及推荐 Python 回归环境。推荐技术栈缺失只会作为建议提示，不会自动阻止 QA Agent；真实执行能力缺失时应先按提示修复，再开始第一次测试。

推荐回归技术栈详见 [`skill/qa-agent/references/recommended-regression-stack.md`](skill/qa-agent/references/recommended-regression-stack.md)。

## 5 分钟 Quick Start

```text
1. qa-agent init --cursor        # 初始化项目和宿主
2. qa-agent doctor               # 确认能力就绪
3. 在 Agent 对话中说：帮我测试登录流程
4. Agent 阅读源码、生成 PRD 并展示
5. QA 回复：确认测试方案
6. QA 回复：确认开始测试
7. Agent 执行测试并生成报告
```

两种模式可选：

- **普通模式**（默认）：`帮我测试登录流程。` — AI 按已批准 PRD 连续执行。
- **Guided 模式**：`以 QA 引导模式测试首次安装的 Welcome Dialog。` — QA 逐步批准每个操作并判定结果。

完整 10 步流程详见 [`skill/qa-agent/references/full-workflow.md`](skill/qa-agent/references/full-workflow.md)。

## 常用命令速查

```bash
qa-agent init                  # 初始化项目和宿主
qa-agent check --request TEXT  # 创建或恢复 Task（不启动 Run）
qa-agent continue              # 继续当前 Session 绑定的 Task
qa-agent finish                # 关闭当前 Session（不归档 Task）
qa-agent doctor                # 检查项目和宿主能力
qa-agent update                # 刷新同版本 Runtime 托管文件
```

查看高级命令：

```bash
qa-agent help --advanced
```

完整命令参考详见 [`skill/qa-agent/references/cli-command-reference.md`](skill/qa-agent/references/cli-command-reference.md)。

生成文件与目录结构详见 [`skill/qa-agent/references/directory-structure.md`](skill/qa-agent/references/directory-structure.md)。

## 项目验证

```bash
qa-agent doctor
qa-agent validate
```

开发本项目：

```bash
npm install
npm run verify      # TypeScript 检查 + 构建 + 完整测试
npm run pack:check
```

## 三个 Skill

- `qa-agent`：AI 主导测试、PRD 双门禁、严格矩阵与发布计划、Python 草稿与发布；
- `qa-agent-guided`：QA 主导的单步测试，每个操作前批准、操作后判定；
- `qa-agent-regression-test`：只运行 Task 中已批准的 Python 回归脚本，并审视 Runtime 自动生成的回归报告。
