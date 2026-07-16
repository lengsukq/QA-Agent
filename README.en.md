# QA Agent Skill

[简体中文](README.md)

A local-first QA Agent runtime and cross-host Skill package for validating real business outcomes.

It is not a static test-case runner. The Agent learns the business module and role, plans coverage, operates a real browser or simulator, verifies the rendered business outcome, captures screenshots and evidence, writes a QA report, and stores reviewed project knowledge for future regression work.

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

The host supplies browser, simulator, device, or MCP permissions. `qa-agent` supplies the shared planning, approval, evidence, reporting, and project-memory workflow. It is a QA brain, not a new browser or simulator framework. The repository's Playwright adapter is a local development/reference capability; real Web, Android, and iOS operations should use the host Agent's approved MCPs or local tools.

## Prerequisites

- Node.js `>= 22.6`
- npm
- Playwright Chromium for browser verification; if needed run `npx playwright install chromium`
- A host with the relevant browser, simulator, or device-control capability for real UI execution

## Start the runtime

```bash
cd /Users/leo/Documents/code/QA-Agent
npm install
npm test
npm run qa-agent -- help
```

The test suite launches a local Chromium fixture and verifies browser actions, screenshots, visual assertions, reports, mobile preflight, approval invalidation, and host integrations.

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
node /Users/leo/Documents/code/QA-Agent/bin/qa-agent.mjs init \
  --id my-app \
  --name "My App" \
  --description "Business application QA project"

node /Users/leo/Documents/code/QA-Agent/bin/qa-agent.mjs doctor
```

```text
.qa-agent/
├── modules/          # Business modules and Tasks
├── runs/             # Execution records
├── evidence/         # Screenshots, traces, and logs
├── reports/          # Generated Markdown reports
├── shared-memory/    # Reviewed project knowledge
├── policies.json     # Safety policy
└── capabilities.json # Declared capabilities
```

## Recommended workflow

The examples below assume `qa-agent` is on `PATH`. During local development, replace it with `node /Users/leo/Documents/code/QA-Agent/bin/qa-agent.mjs`.

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

### 1. Create a module and test plan

```bash
qa-agent module create checkout \
  --name "Checkout" \
  --description "Users confirm items, pricing, and delivery information before checkout" \
  --risk high

qa-agent module plan checkout
qa-agent task create checkout-basic-flow --module checkout
qa-agent task plan checkout-basic-flow --module checkout
```

Planning covers core flows, boundaries, permissions, state transitions, exceptions, idempotency, dependencies, and regression history. `task plan` is the reviewable test-case contract: business logic, preconditions, data, scenarios, expected outcomes, visual assertions, evidence, and safety stops.

Before drafting a new plan, the host Agent may use approved read-only source or MCP tools to understand routes, components, APIs, permissions, and state transitions. Source findings are **inferred planning context**, not proof that the business behavior is correct; final conclusions still require real run evidence.

### 2. Obtain user approval before execution

No browser or APP action may begin until the user confirms the generated test cases and business logic.

```bash
qa-agent task review checkout-basic-flow --module checkout --approve --confirmed-by "leo"
```

Approval is tied to the current test-plan hash. Changing business logic, expected results, Runbook steps, test data, capabilities, or safety boundaries invalidates the approval and returns the Task to `needs_review`. An unchanged approved plan can run repeatedly for regression work without asking again.

### 3. Configure deterministic browser execution

```bash
qa-agent adapter playwright --base-url http://localhost:3000
```

Example `checkout-runbook.json`:

```json
{
  "startPath": "/checkout",
  "steps": [
    { "id": "total-visible", "action": "assert-visible", "locator": "[data-testid=order-total]" },
    { "id": "total-text", "action": "assert-text", "locator": "[data-testid=order-total]", "expected": "$199.00" },
    { "id": "result-shot", "action": "screenshot", "description": "The total and checkout action are visible" }
  ]
}
```

```bash
qa-agent task runbook checkout-basic-flow --module checkout --file checkout-runbook.json
# Re-confirm the plan if the Runbook changed.
qa-agent task review checkout-basic-flow --module checkout --approve --confirmed-by "leo"
qa-agent task run checkout-basic-flow --module checkout
```

### 4. Agent-guided real UI QA

This is the preferred business-QA mode. The runtime uses the `qa-agent/v2` data contract. The host Agent opens the real browser or simulator and observes the current screen before selecting an action. It captures a screenshot after every real UI action, but invokes visual recognition adaptively at key business assertions, amounts, permissions, state/result changes, unexpected screens, locator adaptations, failures, and the final state. Reports distinguish `Screenshot captured`, `Visual inspection performed`, and `Visual inspection not required`. It must not ask the user to click, capture screenshots, or create the report.

```bash
qa-agent context module checkout
qa-agent run start checkout-basic-flow --module checkout
qa-agent run step <run-id> --action "Open checkout" --detail "The Agent opened the real checkout screen." --screenshot /absolute/path/checkout-open.png --visual-inspection not-required
qa-agent run observe <run-id> \
  --scenario happy-path \
  --assertion business-outcome \
  --expected "The total, address, and checkout entry point are correct" \
  --actual "The screen shows $199.00, the default address, and an enabled checkout button" \
  --status passed \
  --screenshot /absolute/path/checkout-result.png
qa-agent run complete <run-id>
```

The report is written to `.qa-agent/reports/<run-id>.md`. Passed and failed visual assertions require a screenshot and reports embed available screenshots.

### 5. Fast regression replay

After a successful run, the Agent creates a candidate OperationPlan under `.qa-agent/modules/<module>/tasks/<task>/operations/`. Review it before reuse:

```bash
qa-agent task operation list checkout-basic-flow --module checkout
qa-agent task operation review checkout-basic-flow --module checkout --operation OPERATION_ID --approve
qa-agent run replay checkout-basic-flow --module checkout --operation OPERATION_ID
qa-agent run recover <run-id> --reason "Element was not ready" --action wait --detail "Element appeared; resume from checkpoint" --outcome continued
```

Replay is permitted only when the Task plan hash and user approval, an active OperationPlan, platform/device/app or Web version, environment/role, test data, required MCPs, and verified macOS permissions are compatible. It skips rediscovery, not business assertions. Outcomes are `PASS`, `FAIL`, `ADAPTED`, `BLOCKED`, or `NEEDS_CONFIRMATION`. Recovery is limited to `wait`, `refresh`, `back`, `restart-app`, `reset-sandbox-data`, `reconnect-mcp`, `fallback-locator`, and `resume-checkpoint`; never modify source code, bypass permissions, or fabricate results.

OperationPlans are Scenario-specific. Each step stores an operation action, primary and fallback locators, redacted input references, preconditions, expected state, assertion references, screenshot and visual-inspection policies, safety action, and checkpoint. During replay every `run step` must reference the next `operationStepId`; steps cannot be skipped or duplicated.

## APP and simulator QA

Declare the platform when initializing the project or creating a module:

```bash
qa-agent init --id my-app --name "My App" --platforms android,ios
qa-agent module create checkout --name "Checkout" --platforms android
```

Before an APP run, the runtime requires Android `android.adb` and `android.screenshot`, or iOS `ios.simulator.interact` and `ios.screenshot`.

On macOS, the host app also needs **Screen Recording** (screenshots/visual evidence) and **Accessibility** (clicks, input, and simulator control). iOS simulator automation may additionally require Developer Mode. The Agent cannot grant system permissions; `mobile doctor` reports the required permissions, validation steps, and the System Settings → Privacy & Security location.

```bash
qa-agent mobile doctor --platform android
```

If a capability is missing, the Run is `BLOCKED`. The Agent must ask the user to approve connecting or installing the least-privilege Android Emulator/ADB or iOS Simulator/Appium MCP. It never installs an MCP automatically.

After approval and connection, declare and activate the project MCP:

```bash
qa-agent mcp add android-emulator --capabilities android.adb,android.screenshot --readonly
qa-agent mcp activate android-emulator --permissions verified
qa-agent mobile doctor --platform android
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
qa-agent mobile doctor --platform android
qa-agent capability list
qa-agent mcp list
qa-agent context module <module-id>
qa-agent module coverage <module-id>
qa-agent task list
qa-agent run show <run-id>
qa-agent run report <run-id>
qa-agent memory list
qa-agent source diagnose --module <module-id> --query "keyword"
qa-agent help
```

## Development and verification

```bash
npm test
npm run qa-agent -- skill validate
npm pack --dry-run
```
