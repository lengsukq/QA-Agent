# QA Agent

QA Agent is a project-local AI testing runtime. Developers can request real UI checks in natural language while the Runtime persists Tasks, Runs, screenshots, business observations, cleanup, and reports.

Current version: **v0.3.96**

### What's new in v0.3.96

- **Agent-inferred platform** — after the detailed TestPlan is generated, the Agent infers the unique Web or iOS platform from source/configuration and asks the QA only when the evidence is ambiguous.
- **Risk-based confirmation** — eligible read-only checks use one `confirm test and start execution` reply; state-changing or high-risk flows retain separate plan and start confirmations.

- **Locked built-in Runner** — npm ships the unified Runner; Web and iOS Simulator UI actions and JSON replay use it exclusively.
- **qa-agent-doctor** — New first-run environment Skill that separates blocking capabilities from advisory tools and guides one repair step at a time.
- **Regression step export** — `qa-agent regression export` extracts validated steps from a Source Run into a JSON replay draft.
- **Capability detection** — `qa-agent doctor` now auto-detects browser, simulator, device, and Python regression environment readiness.
- **UI interaction primitives** — New `act` / `driver` modules unify how host Agent UI operations are invoked and verdicts recorded.
- **Task lifecycle management** — Engine refactored with Source Run freeze, regression run isolation, and automatic `stale` marking when TestPlan changes.
- **Fresh initialization** — v0.3.96 does not migrate older Runtime assets; initialize the project again and let Runner resolution use the global/npm package.

v0.3.91 puts AI-led and user-led execution on one Task, Plan, Run, Step, Evidence, and Report core. The modes differ only in who controls the next action:

- the Agent derives a detailed Task PRD from the project;
- every material requirement, environment, account, test-data, expected-result, or safety question must be resolved with the QA;
- eligible ordinary read-only Tasks accept one exact reply, `确认测试并开始执行`, which records both approvals;
- strict Tasks still require `确认测试方案`, then separately `确认开始测试`, before Runtime may create a Run or allow UI tools;
- AI-led mode executes the approved PRD continuously without a per-step prepare gate or human verdict;
- user-led mode keeps only one pending interaction: approve one action, execute and screenshot it, then confirm its result;
- approvals and verdicts are stored directly on the corresponding Step instead of in a second interaction-history state machine;
- after a user-led Run completes, Runtime automatically creates one independent JSON steps draft per selected Scenario;
- Scenario drafts are stored under `source-run/scenario-regressions/<scenario-id>/` and still require separate review before formal publication;
- AI-led Runs retain the optional post-test question for exporting one full-flow JSON steps draft;
- Runtime persists real screenshots, QA decisions, assertions, cleanup, and formal reports;
- PRDs, test reports, and Scenario script drafts are surfaced through clickable Markdown links;
- formal test and regression reports must embed screenshots directly in Markdown rather than list paths only;
- `qa-agent-regression-test` only runs already published scripts;
- strict matrices, release checks, GO/NO-GO, and archive gates remain in the main Skill and Runtime.

## What QA Agent is for

Use QA Agent to:

- test Web or iOS Simulator features;
- let an Agent inspect source before selecting test entry points;
- persist actual actions, screenshots, and business results;
- resume interrupted testing;
- promote a proven flow into reusable regression;
- run impact-aware release GO/NO-GO checks.

QA Agent supports only Web and iOS Simulator through its built-in Runner. The Agent may call `qa-agent act` and Runtime commands only; direct MCP, Playwright, ADB, xcrun, idb, and other UI tools are forbidden.

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
0.3.96
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

The project includes a verified iOS unified-Runner example at [`ios-search-bvl.steps.json`](ios-search-bvl.steps.json). It clears and fills the `com.rechic.apps` search field, searches `bvl`, taps the Bvlgari product into its detail page, scrolls, and asserts product information. See the [CLI command reference](skill/qa-agent/references/cli-command-reference.md) and [regression runner contract](skill/qa-agent/references/regression-runner.md) for the command and JSON replay interfaces.

## Recommended regression stack

The built-in Runner is the only UI execution path. Doctor reports these setup requirements; it does not install third-party packages or modify system permissions.

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

### Platform mismatch

If the selected platform is wrong, stop and run `qa-agent doctor --platforms <web|ios>`, reapply the correct PlanDraft, invalidate the old platform-bound approval, and complete the confirmation mode reported by Runtime. Do not use MCP to bridge a platform mismatch.

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

Python Runtime Agent reference:

```text
skill/qa-agent/references/regression-runner.md
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
5. inspect source, configuration, entry points, and capabilities to infer exactly one platform; persist it in `PlanDraft.platformDeclaration` and reapply the matching plan; ask the QA only when the platform is ambiguous;
6. ask the QA about every unresolved requirement, environment, account, test-data, expected-result, or safety question;
7. persist answers in `confirmedDecisions`, clear resolved `userQuestions`, and reapply the plan;
8. set `PlanDraft.executionIntent`; eligible read-only Tasks use one exact reply `确认测试并开始执行`, while other Tasks require `确认测试方案` followed by `确认开始测试`;
9. only then run capability checks and create the Task's single Source Run.

Vague approval does not satisfy the computed confirmation mode. Runtime/CLI writes Task approval metadata; the Agent does not edit `task.json` manually.

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

For an eligible read-only Task (`confirmationMode=merged`):

```bash
qa-agent plan review   --module MODULE   --task TASK   --approve   --confirmed-by QA   --confirmation-text "确认测试并开始执行"
qa-agent test --module MODULE --task TASK
```

For strict Tasks (`confirmationMode=strict`):

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

Without a pending user-led action approval, Runtime forbids UI execution. After the action, Runtime keeps only a pending result-verdict pointer and forbids another UI action or Run completion until the verdict is stored. Completed approvals and verdicts remain on their Step rather than in a separate interaction-history state machine.

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
    ├── evidence/
    └── scenario-regressions/       # user-led mode only
        └── <scenario-id>/
            ├── steps.json
            └── manifest.json
```

- `source-run/run.json` contains the structured facts from the first real AI test;
- `source-run/report.md` is the authoritative report for that execution;
- `prd.md` stores the reviewed plan and latest result;
- `screenshots/` and `evidence/` contain real artifacts;
- user-led completion writes one independent draft under `scenario-regressions/<scenario-id>/` for every selected Scenario.

A Task no longer keeps multiple `runs/<run-id>/` histories. Before formal regression steps are published, another initial test replaces the unpublished Source Run and records the restart in `events.jsonl`. After publication, the Source Run is frozen and all later execution goes to `regression-runs/`.

When the TestPlan changes, the old regression steps first become `stale`. A platform selection change invalidates platform-bound approvals; Runtime reports the confirmation mode needed after the corrected PlanDraft is applied. New unresolved business questions still require QA confirmation.

v0.3.96 does not create duplicate `summary.md`, Quick observed-Scenario JSON, Source Run history indexes, or Session Journal files.

## Regression steps and the unified Runner

AI-led mode may ask whether to export one full-flow steps draft after Runtime confirms that the Source Run has stable steps, locators, input references, assertions, screenshots, and cleanup.

User-led mode does not ask the same question. `qa-agent run complete` automatically creates one draft per selected Scenario from the human-approved and human-confirmed Steps. Those files remain Source Run artifacts until they are separately reviewed and promoted into the formal regression workflow.

Formal draft generation and publication remain separate decisions:

```text
approve steps export
≠
approve publication into the Task
```

Runtime exports the source Run's actual steps, final locators, input references, business assertions, screenshot points, and cleanup into a Session draft. The Agent does not write Python or invent another test executor:

```bash
qa-agent regression export \
  --module <module> \
  --task <task> \
  --run <source-run> \
  --id <script-id>
```

The draft remains under:

```text
.qa-agent/.runtime/drafts/<session>/<script-id>/
└── steps.json
```

It does not enter the Task, formal regression, or release selection. The Agent must show the complete JSON steps or diff and explain environment variables, the host bridge, assertions, screenshots, and cleanup.

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
│   ├── <script-id>.steps.json
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

Run the published steps from the command line. Runtime resolves the global or npm-packaged unified Runner:

```bash
qa-agent regression run <script-id> \
  --module <module> \
  --task <task> \
```

The replay path is always the unified executor:

```text
qa-agent regression run → python3 -m qa_agent_runner replay <steps-file>
```

The unified Runner fixes execution order and performs Web operations through Playwright or iOS Simulator operations through `xcrun simctl` and `idb`. Runtime stores the structured result and report. The Agent reviews the result, screenshots, stdout, stderr, and cleanup without replanning the steps.

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
qa-agent update
```

Show strict regression, release, and administration commands with:

```bash
qa-agent help --advanced
```

## Initialize v0.3.96

Install the CLI:

```bash
npm install -g qa-agent-skill@0.3.96
```

For a clean v0.3.96 setup, back up the old Runtime directory if needed, then initialize again:

```bash
mv .qa-agent .qa-agent.backup
qa-agent init
```

`qa-agent update` refreshes managed files only for an already initialized v0.3.96 project and resolves the global/npm Runner. Unsupported older versions must be backed up and initialized again.

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

## Four Skills

v0.3.96 installs:

```text
qa-agent
qa-agent-doctor
qa-agent-guided
qa-agent-regression-test
```

- `qa-agent`: AI-led testing, two-stage PRD approval, strict matrices and release planning, results, and JSON steps export/publication;
- `qa-agent-doctor`: first-run project, host, managed Runner, Python, platform tool, and capability readiness guidance;
- `qa-agent-guided`: QA-led single-step testing with action approval before execution and a result verdict afterward;
- `qa-agent-regression-test`: only replays approved JSON steps already stored in a Task through the managed Runner and reviews the Runtime-generated regression report.

Runtime complexity remains internal. Users should only see the goal, progress, result, and any decision they must make.
