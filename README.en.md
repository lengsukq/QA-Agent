# QA Agent

[简体中文](README.md)

AI-powered QA Engineer for business validation and regression testing.

QA Agent is an AI QA Engineer designed for real business validation and regression testing.

It is not a traditional test script runner. It helps teams work like real QA engineers: understand projects, analyze impact, design test plans, validate business workflows, collect evidence, generate reports, and continuously build regression knowledge.

## Why QA Agent

Traditional automation usually focuses on:

- API responses
- DOM selectors
- Fixed test scripts

Real QA needs to answer different questions:

- Does the user actually experience the correct workflow?
- Do business rules behave as expected?
- Did a code change break existing features?
- Can a failure be reproduced and investigated?
- Can previous QA knowledge be reused for regression testing?

QA Agent is not a replacement for Playwright, Appium, or other execution tools. It provides the AI QA reasoning layer.

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

## Core Model

QA Agent manages QA assets through a project-level lifecycle:

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

## What it solves

Traditional automation often checks selectors, APIs, or fixed scripts. QA Agent also checks what a user can actually see, whether the business flow follows its rules, whether failures are understandable, and whether every conclusion is supported by reviewable evidence.

```text
Project → Module → Test Task → Scenario → Run → Step / Evidence / Report / Memory
```

- **Project / Module**: business boundaries, roles, risk, and objectives.
- **Test Task / Scenario**: reviewable business test plans and expectations.
- **Run**: real actions, screenshots, trace/log/network evidence, and outcome.
- **Report**: an automatically generated Markdown report with images.
- **Memory**: reviewed business rules, regressions, and project knowledge under `.qa-agent/`.

Source code, DOM state, and logs support diagnosis only. The rendered business outcome is the primary evidence.

## Supported Agent hosts

| Host | Integration |
| --- | --- |
| Codex | Native Skill |
| Claude Code | Project Skill |
| Cursor | Rule and `/qa-agent` command |
| OpenCode | Project Skill |
| GitHub Copilot | Skill and Custom Agent |
| Gemini CLI | `/qa-agent` command |
| Compatible hosts | `.agents/skills/qa-agent` Skill |

The host supplies and invokes browser, simulator, device, log, database, and source tools. `qa-agent` supplies the shared planning, approval, evidence, reporting, and project-memory workflow. It is a QA brain, not a browser or simulator framework; real Web, Android, and iOS operations always use the host Agent's approved tools.

## Prerequisites

- Node.js `>= 22.6`
- npm
- A host with the relevant browser, simulator, or device-control capability for real UI execution

## Start the runtime

```bash
cd /path/to/QA-Agent
npm install
npm test
npm run qa-agent -- help
```

The test suite verifies host capability snapshots, imported artifacts, visual assertions, replay, reports, mobile preflight, approval invalidation, and host integrations.

## Install a host integration

Use `--scope project` for a version-controlled repository integration. Use `--scope user` for a personal installation that applies to all of a developer's projects. Codex defaults to `user`; other hosts default to `project`.

> A user-scoped installation contains reusable instructions only. Business memory, credential references, Tasks, Runs, screenshots, evidence, and reports always remain inside the active project's `.qa-agent/` directory.

```bash
# Codex user-level installation
node bin/qa-agent.mjs install-host codex --scope user

# Project-level installations
node bin/qa-agent.mjs install-host claude --scope project --project /path/to/your-app
node bin/qa-agent.mjs install-host cursor --scope project --project /path/to/your-app
node bin/qa-agent.mjs install-host opencode --scope project --project /path/to/your-app
node bin/qa-agent.mjs install-host copilot --scope project --project /path/to/your-app
node bin/qa-agent.mjs install-host gemini --scope project --project /path/to/your-app

# User-level installations where supported
node bin/qa-agent.mjs install-host claude --scope user
node bin/qa-agent.mjs install-host opencode --scope user
node bin/qa-agent.mjs install-host copilot --scope user
node bin/qa-agent.mjs install-host gemini --scope user
node bin/qa-agent.mjs install-host agents --scope user
```

Use `--force` only when replacing an existing integration is intended. After installing the Gemini command, run `/commands reload`. Cursor user rules are managed through **Cursor Settings > Rules**, so the CLI only creates its version-controlled project Rule and Command.

## Initialize a tested project

Initialize each tested project separately. All project memory, evidence, and reports stay in that project's `.qa-agent/` boundary.

```bash
cd /path/to/your-app
node /path/to/QA-Agent/bin/qa-agent.mjs init \
  --id my-app \
  --name "My App" \
  --description "Business application QA project"

node /path/to/QA-Agent/bin/qa-agent.mjs doctor
```

```text
.qa-agent/
├── modules/          # Module assets; each Task owns its runs, evidence, reports, and memory
├── index/            # Project-level search/index projections, including runs.jsonl
├── regression-runs/  # Cross-task/module suite orchestration records
├── shared-memory/    # Reviewed project knowledge
├── policies.json     # Safety policy
└── mcp.json          # Host capability snapshot and health state
```

## Recommended workflow

The examples below assume `qa-agent` is on `PATH`. During local development, replace it with `node /path/to/QA-Agent/bin/qa-agent.mjs`.

### The QA Agent closed loop

```text
Load the active project's memory and Module
  → use read-only source/MCP tools to understand routes, APIs, permissions, and states (inferred context only)
  → generate business-logic test cases
  → obtain user confirmation for the current plan version
  → use the host Agent's Browser / Mobile MCP to operate the real business flow
  → capture each consequential state and assertion, recording expected versus actual
  → classify the real UI outcome as PASS / FAIL / BLOCKED / etc.
  → generate an image-rich report
  → create observed-business-rule or known-issue candidate memory
  → promote it to active knowledge only after user review in the same project
```

Source code can reveal candidate rules and aid diagnosis, but never replaces real business validation. Candidate memory always enters the active project's review queue; it never becomes cross-project or global knowledge automatically.

### 1. Bootstrap the Task and Test Plan

Every new QA request starts with Workflow Bootstrap. Mirror the returned `todoList` into the host IDE TodoList. Browser, simulator, device, and UI tools are forbidden until the runtime returns both `uiExecutionAllowed: true` and a `runId`.

```bash
qa-agent workflow bootstrap \
  --request "Verify that the user can review and submit correct checkout information" \
  --module checkout \
  --task checkout-basic-flow \
  --module-name "Checkout" \
  --task-name "Basic checkout flow" \
  --platforms web \
  --risk high
```

The first response is an approval gate:

```json
{
  "workflowStatus": "approval_required",
  "uiExecutionAllowed": false,
  "taskDirectory": ".qa-agent/modules/checkout/tasks/checkout-basic-flow",
  "todoList": [],
  "plan": {}
}
```

The host may use read-only source analysis to refine the plan, then presents the current `plan` and `planHash`. A real human reviewer must approve it before any UI operation:

```bash
qa-agent task review checkout-basic-flow \
  --module checkout \
  --approve \
  --confirmed-by "qa-reviewer"
```

After the host capability snapshot is verified, start the Run:

```bash
qa-agent task run checkout-basic-flow --module checkout
```

```json
{
  "uiExecutionAllowed": true,
  "runId": "run-...",
  "workflow": { "workflowStatus": "running" }
}
```

When the plan, approval, capabilities, or Prompt Bundle are not current, `uiExecutionAllowed` remains `false`.

### 3. Import a host capability snapshot

The host Agent confirms its connected tools and permissions before a Run, then imports that attestation into the project. `qa-agent` never connects MCPs or verifies system permissions itself.

```bash
qa-agent host import --file /absolute/path/host-capabilities.json
```

### 4. Agent-guided real UI QA

This is the preferred business-QA mode. The runtime uses the `qa-agent/v2` data contract. The host Agent opens the real browser or simulator and observes the current screen before selecting an action. It captures a screenshot after every real UI action, but invokes visual recognition adaptively at key business assertions, amounts, permissions, state/result changes, unexpected screens, locator adaptations, failures, and the final state. Reports distinguish `Screenshot captured`, `Visual inspection performed`, and `Visual inspection not required`. It must not ask the user to click, capture screenshots, or create the report.

```bash
qa-agent context module checkout
qa-agent task run checkout-basic-flow --module checkout
qa-agent run step <run-id> --action "Open checkout" --detail "The Agent opened the real checkout screen." --screenshot /absolute/path/checkout-open.png --visual-inspection not-required
qa-agent run evidence <run-id> --type console --summary "Host browser console output" --file /absolute/path/console.log
qa-agent run observe <run-id> \
  --scenario happy-path \
  --assertion business-outcome \
  --expected "The total, address, and checkout entry point are correct" \
  --actual "The screen shows $199.00, the default address, and an enabled checkout button" \
  --status passed \
  --screenshot /absolute/path/checkout-result.png
qa-agent run complete <run-id>
```

`run complete` first enforces a strict closure check: every declared `visualAssertions` id for every selected Scenario must have a matching `run observe`. A PASSED `run step`, including one recorded with `operationAction=assert`, does not replace a business assertion. When an assertion is missing, completion is rejected and the Run remains `running`, so the host can record the missing observations and retry. Only then is the report written to `runs/<run-id>/report.md`, while `runs/index.json` and `runs/latest.json` are updated.

A successful first Run also receives an OperationPlan replay-quality check. `navigate/click/input/fill` steps need explicit actions and locators, while `input/fill` steps also need structured redacted `inputRefs`. Business verification may PASS while replay readiness fails; in that case the report lists `OperationPlan candidate issues` instead of generating an unstable JSON contract. Existing projects can run `qa-agent prompts sync` to refresh `.qa-agent/prompts/`.

When upgrading an existing project, run `qa-agent prompts sync` first. Legacy approvals without `confirmationSource` must be reviewed again by a real human through `task review --approve --confirmed-by <reviewer>`; automated identities such as `qa-agent`, `assistant`, or `system` cannot approve their own plans. A state-mutating Scenario should declare Cleanup and persist its result through `run cleanup` before completion. Human interaction with a system picker must use `--execution-mode user-assisted`; it remains valid business evidence but cannot produce a fully automated OperationPlan.

Each Task is a self-contained test asset directory:

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

### 5. Fast regression replay

After a successful run, the Agent creates a candidate OperationPlan under `.qa-agent/modules/<module>/tasks/<task>/operation-plans/<scenario>/`. Review it before reuse:

```bash
qa-agent task operation list checkout-basic-flow --module checkout
qa-agent task operation review checkout-basic-flow --module checkout --operation OPERATION_ID --approve
qa-agent task run checkout-basic-flow --module checkout --operation OPERATION_ID
qa-agent run recover <run-id> --reason "Element was not ready" --action wait --detail "Element appeared; resume from checkpoint" --outcome continued
qa-agent task regression sync checkout-basic-flow --module checkout
qa-agent task regression run checkout-basic-flow --module checkout
qa-agent module regression run checkout
```

Replay is permitted only when the Task plan hash and user approval, an active OperationPlan, platform/device/app or Web version, environment/role, test data, required MCPs, and verified macOS permissions are compatible. It skips rediscovery, not business assertions. Outcomes are `PASS`, `FAIL`, `ADAPTED`, `BLOCKED`, or `NEEDS_CONFIRMATION`. Recovery is limited to `wait`, `refresh`, `back`, `restart-app`, `reset-sandbox-data`, `reconnect-mcp`, `fallback-locator`, and `resume-checkpoint`; never modify source code, bypass permissions, or fabricate results.

OperationPlans are Scenario-specific. Each step stores an operation action, primary and fallback locators, redacted input references, preconditions, expected state, assertion references, screenshot and visual-inspection policies, safety action, and checkpoint. During replay every `run step` must reference the next `operationStepId`; steps cannot be skipped or duplicated.

A Task-level RegressionSuite organizes all active OperationPlans for one Task. Module replay dynamically aggregates active OperationPlans across Tasks at start, instead of persisting a second Module Suite. It runs independent flows serially, continues after an isolated business failure, and produces an aggregate report. `run.json` is a result record; OperationPlan is the executable operation definition.

### 5. Fast pre-release regression

Mark critical end-to-end flows as Golden Paths and release gates:

```bash
qa-agent task update buyer-purchase --module checkout --golden-path --estimated-minutes 8
```

Inspect change impact and the proposed execution scope:

```bash
qa-agent impact analyze --base origin/main --head HEAD
qa-agent release check --profile fast --base origin/main --head HEAD --plan-only
```

Start the release regression directly:

```bash
qa-agent release check --profile fast --base origin/main --head HEAD
# The host Agent completes the returned child Runs automatically.
qa-agent release complete RELEASE_CHECK_ID
```

Profiles:

- `fast`: global release gates, Golden Paths, `every-release` Tasks, and impacted P0 flows.
- `normal`: fast plus impacted P1 flows.
- `full`: every reviewed active OperationPlan.

ImpactAnalysis uses Module ids, source hints, entry points, dependencies, and Task triggers, while preserving unmatched files and selection reasons. ReleaseCheck returns `GO`, `NO-GO`, or `REVIEW`. Its report is stored at `.qa-agent/reports/<release-check-id>.md` and references child Task reports and screenshot evidence without duplicating every image.

## APP and simulator QA

Declare the platform when initializing the project or creating a module:

```bash
qa-agent init --id my-app --name "My App" --platforms android,ios
qa-agent module create checkout --name "Checkout" --platforms android
```

Before an APP run, the runtime requires Android `android.adb` and `android.screenshot`, or iOS `ios.simulator.interact` and `ios.screenshot`.

On macOS, the host app also needs **Screen Recording** (screenshots/visual evidence) and **Accessibility** (clicks, input, and simulator control). iOS simulator automation may additionally require Developer Mode. The Agent cannot grant system permissions; `host doctor --platform` reports the required permissions, validation steps, and the System Settings → Privacy & Security location from the host-imported snapshot.

```bash
qa-agent host doctor --platform android
```

If a capability is missing, the Run is `BLOCKED`. The Agent must ask the user to approve connecting or installing the least-privilege Android Emulator/ADB or iOS Simulator/Appium MCP. It never installs an MCP automatically.

After approval and connection, import a fresh host capability snapshot:

```bash
qa-agent host import --file /absolute/path/android-host-capabilities.json
qa-agent host doctor --platform android
```

The host Agent then operates the simulator, captures visual evidence, and creates the same automatic report.

## Reports and project memory

Each report includes context, the approved plan, scenario results, expected versus actual outcomes, visual assertions, embedded screenshots, traces/logs/network evidence, blocker recovery conditions, defect candidates, release guidance, and candidate memory. Passed evidence-backed visual runs automatically create `observed` business-outcome candidates; failed runs create known-issue candidates. Both require review before becoming active project knowledge.

Store a confirmed rule or regression lesson inside its project:

```bash
qa-agent memory add checkout-total-rule \
  --module checkout \
  --title "Checkout total rule" \
  --content "Before confirmation, buyers must see item cost, shipping, discounts, and the payable total."

qa-agent memory review checkout-total-rule --module checkout --approve
```

## Safety

- Stop before real payments, refunds, deletion, notifications, and production permission changes.
- Default source and data access is read-only; the QA Agent does not modify source, commit Git changes, or alter production configuration.
- Never persist passwords, tokens, cookies, private keys, payment data, or unredacted production data.
- Missing capabilities, credentials, approvals, or clear business rules produce `blocked` or `paused`, never a fabricated pass.

Configure project policy in `.qa-agent/policies.json`.

## Common commands

```bash
qa-agent doctor
qa-agent host doctor --platform android
qa-agent host list
qa-agent context module <module-id>
qa-agent module coverage <module-id>
qa-agent task list
qa-agent run show <run-id>
qa-agent run report <run-id>
qa-agent memory list
qa-agent help
```

## Development and verification

```bash
npm test
npm run qa-agent -- skill validate
npm pack --dry-run
```
