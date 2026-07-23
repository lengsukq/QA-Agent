# QA Agent

QA Agent is a project-local AI testing runtime. Developers can request real UI checks in natural language while the Runtime persists Tasks, Runs, screenshots, business observations, cleanup, and reports.

Current version: **v0.3.5**

v0.3.5 strengthens the regression screenshot contract while retaining two-stage PRD approval and QA-led Guided mode:

- the Agent derives a detailed Task PRD from the project;
- every material requirement, environment, account, test-data, expected-result, or safety question must be resolved with the QA;
- the QA first replies `确认测试方案` to confirm that the PRD matches the requirement;
- the QA separately replies `确认开始测试` before Runtime may create a Run or allow UI tools;
- the main `qa-agent` performs AI-led execution;
- `qa-agent-guided` requires human approval before each UI action and a human verdict after each observed result;
- Runtime persists screenshots, QA decisions, assertions, cleanup, and formal reports;
- Python draft generation and publication still require separate approvals;
- `qa-agent-regression-test` only runs already published scripts;
- every formal Python regression must capture a real checkpoint screenshot for each source UI step;
- missing, empty, misplaced, or incomplete screenshot coverage makes the result `invalid_result`;
- the Agent must inspect screenshots against expected and actual states before presenting a formal regression report;
- strict matrices, release checks, GO/NO-GO, and archive gates remain in the main Skill and Runtime.

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
0.3.5
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

For an AI-led check, say:

```text
Test the login flow.
```

For QA-led step-by-step execution, say:

```text
Use Guided QA to test the first-install Welcome Dialog.
```

The shared planning order is mandatory:

1. create or resume a Task without creating a Run;
2. inspect relevant source, routes, tests, configuration, and existing QA assets;
3. generate detailed Scenarios whose steps contain an action and expected result;
4. write and present the complete Task `prd.md`;
5. ask the QA about every unresolved requirement, environment, account, test-data, expected-result, or safety question;
6. persist answers in `confirmedDecisions`, clear resolved `userQuestions`, and reapply the plan;
7. require the exact reply `确认测试方案` and persist it with `qa-agent plan review`;
8. separately require `确认开始测试` and persist it with `qa-agent review`;
9. only then run capability checks and create the Task's single Source Run.

Vague approval does not satisfy either gate.

## Quick and Guided checks

Create an AI-led Task:

```bash
qa-agent check --request "Test the login flow"
```

Create a QA-led Task:

```bash
qa-agent check --mode guided --request "Test the first-install Welcome Dialog"
```

After applying and presenting the PRD:

```bash
qa-agent plan review   --module MODULE   --task TASK   --approve   --confirmed-by QA   --confirmation-text "确认测试方案"

qa-agent review   --module MODULE   --task TASK   --approve   --confirmed-by QA   --confirmation-text "确认开始测试"

qa-agent test --module MODULE --task TASK
```

Quick mode executes the approved flow continuously while persisting each real action, screenshot, assertion, cleanup result, and recovery attempt.

Guided mode enforces this loop:

```text
Agent proposes one action and expected result
→ QA approves or changes that action
→ Runtime records the action approval
→ Agent executes only that action and captures a screenshot
→ Agent presents the observed result
→ QA records a pass/fail/block/pause/inconclusive verdict
→ only then may the next UI action start
```

Guided commands:

```bash
qa-agent run guide-approve RUN   --scenario SCENARIO   --planned-step STEP   --confirmed-by QA   --confirmation-text "Yes, execute this step"

qa-agent run step RUN ...

qa-agent run guide-verdict RUN   --step STEP   --status passed   --confirmed-by QA   --confirmation-text "Yes, this matches the expected result"
```

Without a pending Guided action approval, Runtime forbids UI execution. After the action, Runtime forbids another UI action and Run completion until the QA verdict is stored.

After interruption, use `qa-agent continue`. `qa-agent finish` closes the current Session but does not archive or delete the Task.

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

v0.3.5 does not create duplicate `summary.md`, Quick observed-Scenario JSON, Source Run history indexes, or Session Journal files.

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

`qa-agent finish` closes the current Session while preserving Task assets. It does not archive a persistent Guided or regression Task.

## Strict regression and release validation

Fixed Scenario matrices, reviewed release scope, impact analysis, release readiness, GO/NO-GO, and Release Gates remain in the main `qa-agent` Skill. The former planning-only Skill has been replaced by `qa-agent-guided`.

Strict and release workflows use the same unresolved-question handling, exact `确认测试方案` PRD confirmation, and separate `确认开始测试` execution authorization. Plan hashes, reviewed Python scripts, real script validation, Task/Module/Release selection, impact analysis, release decisions, and archive gates remain available.

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

## Upgrade to v0.3.5

Upgrade the CLI:

```bash
npm install -g qa-agent-skill@0.3.5
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

v0.3.5 installs:

```text
qa-agent
qa-agent-guided
qa-agent-regression-test
```

- `qa-agent`: AI-led testing, two-stage PRD approval, strict matrices and release planning, results, and Python draft/publication;
- `qa-agent-guided`: QA-led single-step testing with action approval before execution and a result verdict afterward;
- `qa-agent-regression-test`: only runs approved Python regression scripts already stored in a Task and reviews the Runtime-generated regression report.

Runtime complexity remains internal. Users should only see the goal, progress, result, and any decision they must make.
