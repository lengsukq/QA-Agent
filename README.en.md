# QA Agent

QA Agent is a project-local AI testing runtime. Developers can request real UI checks in natural language while the Runtime persists Tasks, Runs, screenshots, business observations, cleanup, and reports.

Current version: **v0.3.3**

v0.3.3 separates Python script creation from regression execution:

- the Agent creates the Task first, then derives a detailed plan from the project with Step, Operation, and Expected Result entries;
- Runtime writes the complete review plan into the Task `prd.md`, and the user must explicitly reply `确认开始测试`;
- before that exact reply, Runtime creates no Run and the Agent may not invoke UI testing tools;
- Runtime generates the screenshot-backed report;
- after testing, the Agent may ask whether to generate Python from the exact executed flow;
- the first confirmation permits a temporary draft only;
- a second explicit approval is required after the user reviews the complete script or diff;
- the main `qa-agent` Skill keeps draft creation and publication;
- the dedicated `qa-agent-regression-test` Skill only runs already published scripts and reviews the Runtime-generated regression report;
- ordinary testing still defaults to Quick Check and the installation remains three Skills;
- safety gates, real evidence, strict release checks, and archive remain intact.

## What QA Agent is for

Use QA Agent to:

- test Web, Android, or iOS features;
- let an Agent inspect source before selecting test entry points;
- persist actual actions, screenshots, and business results;
- resume interrupted testing;
- promote a proven flow into reusable regression;
- run impact-aware release GO/NO-GO checks.

QA Agent does not replace browser, simulator, or device tooling. The host Agent calls tools such as Playwright, ADB, or iOS Simulator MCP. QA Agent owns state, safety, evidence, reports, and regression assets.

## Install

Requirements:

- Node.js 22.6 or newer;
- an Agent host that supports Skills, commands, or project rules;
- browser, simulator, or device capabilities for real UI execution.

Install globally:

```bash
npm install -g qa-agent-skill
```

Confirm the version:

```bash
qa-agent --version
```

Expected output:

```text
0.3.3
```

## Initialize a project

From the tested project:

```bash
cd /path/to/project
qa-agent init
```

Initialize and configure a host:

```bash
qa-agent init --cursor
qa-agent init --codex
qa-agent init --claude
qa-agent init --copilot
qa-agent init --gemini
qa-agent init --opencode
qa-agent init --agents
```

Multiple hosts may be configured together:

```bash
qa-agent init --cursor --codex --claude
```

Or configure a specific project directly:

```bash
qa-agent configure \
  --project /path/to/project \
  --host cursor
```

Runtime data is stored under:

```text
.qa-agent/
```

Users should not edit Runtime-owned JSON manually.

## First-run check (recommended)

After project initialization, run:

```bash
qa-agent doctor
```

Doctor checks:

- whether the `.qa-agent/` project is initialized correctly;
- whether the current host, browser, simulator, or device capabilities are available;
- the recommended Python regression environment for the configured platforms;
- missing tools, permissions, and issues that may block real UI execution.

Missing recommended tools are advisory and do not automatically block QA Agent. Missing browser, simulator, device, or required permission capabilities should be resolved before the first real test.

Recommended first-use order:

```text
Install QA Agent
→ initialize the tested project and Agent host
→ qa-agent doctor
→ resolve required capability or permission issues
→ start the first test in the Agent conversation
```

## Recommended regression stack

This is QA Agent's default recommendation, not a mandatory dependency. An existing automation framework may remain in use when it can run directly from the command line, write the QA Agent `result.json`, produce the Runtime report, and preserve required screenshots.

### Web external testing

```text
Python 3.12+ + pytest + pytest-playwright + Playwright
```

Use it for browser actions, stable locators, assertions, and screenshots.

### iOS Simulator testing

```text
Python 3.12+ + pytest + xcrun simctl + fb-idb CLI + idb_companion
```

Use `simctl` for simulator, app, permission, and screenshot management; use `fb-idb` with `idb_companion` for UI automation; use pytest for fixtures, assertions, parameterization, and cleanup.

### Agent-assisted exploration

`ios-simulator-mcp` may assist the first exploratory run and screenshots, but it is not the only dependency of a formal Python regression script.

### Formal output

```text
result.json
+ report.md
+ screenshots/
+ stdout.log
+ stderr.log
+ evidence/ (when useful)
```

See the first-run Doctor guidance above. Missing recommendations do not automatically block QA Agent.

Full reference:

```text
skill/qa-agent/references/recommended-regression-stack.md
```
## Simplest interaction

For the first use, run this from the tested project:

```bash
qa-agent doctor
```

After resolving any required execution-capability or permission issue, say in the Agent conversation:

```text
Test the login flow.
```

The Agent follows this order:

1. create or reuse the Task directory without creating a Run;
2. inspect relevant source, routes, tests, and configuration;
3. build detailed Scenarios whose steps each contain an operation and expected result;
4. write the complete review plan to the Task `prd.md`;
5. present the Task PRD to the user;
6. require the exact reply `确认开始测试`;
7. only after Runtime records that reply, verify browser, simulator, or device capability and create a Run;
8. execute real UI actions and save screenshots and business observations;
9. perform cleanup and generate the Runtime report;
10. append the latest result to the Task PRD;
11. return a concise result;
12. when the flow is suitable for reuse, ask whether to generate a Python regression script.

After an interruption, say:

```text
Continue.
```

To end the current QA session, say:

```text
Finish this test.
```

Users do not need to know Module, Task, Run, hash, or gate identifiers.

## Quick Check

The CLI can also be used directly:

```bash
qa-agent check "Test the login flow"
```

Compatible form:

```bash
qa-agent check --request "Test the login flow"
```

`check` creates the Task and review PRD only. It never starts testing. After the Agent refines the detailed steps from project source, the user reviews `prd.md` and replies exactly:

```text
确认开始测试
```

Then persist approval and start the Run:

```bash
qa-agent review \
  --module MODULE \
  --task TASK \
  --approve \
  --confirmed-by USER \
  --confirmation-text "确认开始测试"

qa-agent test --module MODULE --task TASK
```

Before that exact reply, `qa-agent test` fails without creating a Run.

Continue:

```bash
qa-agent continue
```

Finish the session:

```bash
qa-agent finish
```

Quick Check remains lightweight, but it now also requires review of the detailed TestPlan and Task PRD plus the exact reply `确认开始测试`. It enforces:

- a Task PRD matching the current plan hash;
- exact human start confirmation;
- capability and permission checks;
- screenshot and business-assertion requirements;
- cleanup;
- Runtime-owned reports;
- policies that stop real payment, refund, production write, and similar actions.

## Initial Task test assets

Each Task keeps exactly one Source Run used to derive the reusable script:

```text
.qa-agent/modules/<module>/tasks/<task>/
├── task.json
├── prd.md
├── requirements.json
├── test-plan.json
├── scenarios/
└── source-run/
    ├── run.json
    ├── report.md
    ├── screenshots/
    └── evidence/
```

- `source-run/run.json` contains the structured facts from the first real AI test;
- `source-run/report.md` is the authoritative report for that execution;
- `prd.md` stores the reviewed plan and latest result;
- `screenshots/` and `evidence/` contain real artifacts.

A Task no longer keeps multiple `runs/<run-id>/` histories. Before a formal Python script is published, another initial test replaces the unpublished Source Run and records the restart in `events.jsonl`. After publication, the Source Run is frozen and all later execution goes to `regression-runs/`.

When the TestPlan changes, the old Python script first becomes `stale`. After the user reviews and approves the changed plan, Runtime may create a replacement Source Run and a revised script.

v0.3.3 does not create duplicate `summary.md`, Quick observed-Scenario JSON, Source Run history indexes, or Session Journal files.

## Python regression scripts

After testing produces a screenshot-backed report, the Agent may ask whether to generate Python when Runtime confirms that the source Run has stable steps, locators, input references, assertions, screenshots, and cleanup.

There are two independent approvals:

```text
approve draft generation
≠
approve publication into the Task
```

After the first approval, the Agent writes Python from the source Run's actual steps, final locators, input references, business assertions, screenshot points, and cleanup, then saves a Session draft:

```bash
qa-agent regression draft \
  --module <module> \
  --task <task> \
  --run <source-run> \
  --file <temporary-script.py> \
  --id <script-id>
```

The draft remains under:

```text
.qa-agent/.runtime/drafts/<session>/<script-id>/
```

It does not enter the Task, formal regression, or release selection. The Agent must show the complete script or complete diff and explain environment variables, the host bridge, assertions, screenshots, and cleanup.

Only after the user explicitly approves the reviewed script may Runtime publish it:

```bash
qa-agent regression publish \
  --module <module> \
  --task <task> \
  --draft <script-id> \
  --confirmed-by <human>
```

Formal assets are stored under:

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

Run the formal script from the command line:

```bash
qa-agent regression run <script-id> \
  --module <module> \
  --task <task> \
  --bridge '<host bridge command>'
```

Python fixes the execution order and the host bridge performs real browser, simulator, or device operations. Runtime stores the structured result and report. The Agent reviews the result, screenshots, stdout, stderr, and cleanup without replanning the steps.

A completed script contract becomes `validated`. A genuine business assertion may fail while the script contract remains valid; the Run still records the business FAIL.

## Sessions and continuation

`check`, `start`, `review`, and `test` bind a Task to the current QA Session.

When the host has a stable conversation or window identifier, use:

```bash
qa-agent continue --session cursor-window-a
```

or:

```bash
export QA_AGENT_SESSION_KEY=cursor-window-a
```

Different windows may work on different Tasks. Runtime automatically resumes the only unfinished Task when safe; with multiple candidates it requests a selection and never guesses.

`qa-agent finish` closes the current Session while preserving Task assets. It does not archive a strict regression Task.

## Strict regression and release validation

Strict planning is used only when the user explicitly requests:

- a fixed reviewed Scenario matrix before execution;
- a fixed and reviewed release test scope;
- release readiness;
- GO/NO-GO;
- a Release Gate.

The host loads:

```text
qa-agent-plan
```

After planning and explicit human approval, the main `qa-agent` performs the first real business test. Later Task, Module, and Release regression select validated Python scripts directly.

Strict capabilities remain available:

- PlanDraft;
- human TestPlan approval;
- plan hashes;
- user-reviewed Python scripts;
- real Python execution validation;
- Task, Module, and Release script selection;
- impact analysis;
- release GO/NO-GO;
- archive gates.

These protocol details remain hidden during ordinary Quick Checks.

## Safety

Runtime stops before:

- real payment or refund;
- production deletion or database write;
- real SMS, email, or notification delivery;
- production permission changes;
- unsafe production-account or raw production-data use;
- missing tool or OS permission;
- execution-contract drift.

The Agent must never fabricate screenshots, UI actions, observations, cleanup, approvals, regression outcomes, or formal reports.

## Common commands

Default help shows only six commands:

```bash
qa-agent init
qa-agent check --request TEXT
qa-agent continue
qa-agent finish
qa-agent doctor
qa-agent update --migrate
```

Show strict regression, release, and administration commands with:

```bash
qa-agent help --advanced
```

## Upgrade to v0.3.3

Upgrade the CLI:

```bash
npm install -g qa-agent-skill@0.3.3
```

Then update an existing project:

```bash
qa-agent update --migrate --force
```

Migration continues to read v0.2 assets and maps the legacy `finalizing` state to `reviewing_result`. Existing Runs, reports, and screenshots are preserved.

## Validate a project

```bash
qa-agent doctor
qa-agent validate
```

Develop this repository:

```bash
npm install
npm run verify
npm run pack:check
```

## Three Skills

v0.3.3 installs:

```text
qa-agent
qa-agent-plan
qa-agent-regression-test
```

- `qa-agent`: ordinary testing, continuation, recovery, result presentation, Python draft/publication, and strict Runtime execution;
- `qa-agent-plan`: strict regression or release planning and human approval;
- `qa-agent-regression-test`: only runs approved Python regression scripts already stored in a Task and reviews the Runtime-generated regression report.

Runtime complexity remains internal. Users should only see the goal, progress, result, and any decision they must make.
