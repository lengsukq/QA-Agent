# Regression Runner Contract

Use this contract only after the Task's real Source Run has completed and `pythonRegressionEligibility.eligible=true`.

Skill ownership:

- main `qa-agent`: exports steps from the completed Run, presents them for review, and publishes after separate approval;
- `qa-agent-regression-test`: replays already published steps and reviews the Runtime-generated report.

## Architecture

Regression uses a **structured steps file** (`.steps.json`) replayed by the built-in Python runner. The Agent never writes Python scripts; Runtime exports steps automatically from the completed Source Run.

```text
Source Run (act commands) → exportStepsFromRun() → .steps.json → python3 -m qa_agent_runner replay
```

## Steps file format

Format identifier: `qa-agent/regression-steps/v1`

```json
{
  "format": "qa-agent/regression-steps/v1",
  "scriptId": "login-flow",
  "sourceRunId": "run-...",
  "sourceFlowHash": "sha256...",
  "platform": "web",
  "steps": [
    { "cmd": "navigate", "params": { "url": "https://example.com" } },
    { "cmd": "click", "params": { "locator": "role=button:Login" } },
    { "cmd": "fill", "params": { "locator": "css=#email", "inputRef": "user.email" } },
    { "cmd": "assert-text", "params": { "locator": "css=.welcome", "expected": "Hello" } }
  ]
}
```

### Step commands

| cmd | params | Platform |
| --- | --- | --- |
| `navigate` | `url` | web |
| `click` | `locator` | web |
| `fill` | `locator`, `inputRef` or `value` | web |
| `select` | `locator`, `value` | web |
| `assert-text` | `locator`, `expected` | web, ios |
| `assert-visible` | `locator` | web, ios |
| `tap` | `x`, `y` | ios |
| `type-text` | `inputRef` or `value` | ios |
| `swipe` | `direction` or `x1,y1,x2,y2` | ios |
| `launch` | `bundleId` | ios |
| `home` | — | ios |
| `back` | — | ios |
| `wait` | `ms` or `locator` | web, ios |
| `screenshot` | `name` | web, ios |
| `scroll` | `direction` | web |
| `hover` | `locator` | web |
| `describe` | — | ios |

### Locator format

`strategy=value` — e.g. `role=button:Login`, `css=#submit`, `text=Welcome`.

## Approval boundaries

Export approval and publication approval are separate decisions.

```text
approve steps export ≠ approve publication
```

Runtime exports steps from the exact completed Run. Runtime validates, stores, publishes, replays, and reports.

## Source contract

The source Run must provide:

- `passed` or `adapted` completed status;
- Runtime-owned report;
- host-automated UI steps via `qa-agent act` commands;
- stable locators for interactive actions;
- structured `inputRefs` instead of raw secrets;
- screenshot evidence for every source UI step;
- screenshot-backed business assertions;
- completed declared Cleanup.

Runtime computes `sourceFlowHash` directly from the recorded steps, locators, input references, assertions, screenshots, and Cleanup.

## Draft and publication

Export steps from a completed Run:

```bash
qa-agent regression export --module MODULE --task TASK --run RUN_ID [--id SCRIPT_ID]
```

Show the complete steps file. After explicit review approval, publish:

```bash
qa-agent regression publish --module MODULE --task TASK --draft SCRIPT_ID --confirmed-by HUMAN
```

A draft is not a formal Task asset. Publication places the `.steps.json` file and its manifest under `regression/` and freezes the current Source Run. Later execution must use the published steps; do not start another initial Source Run unless the TestPlan changes and the old steps become `stale`. A normal plan or platform correction does not require repeating the two QA confirmations.

## Execution

Replay published steps:

```bash
qa-agent regression run SCRIPT_ID --module MODULE --task TASK
```

The runner executes:

```bash
python3 -m qa_agent_runner replay <steps-file>
```

Environment variables set by Runtime:

- `QA_AGENT_SCREENSHOT_DIR` — where screenshots are saved
- `QA_AGENT_RESULT_PATH` — where `result.json` is written

The runner captures a real screenshot after every UI step and writes a structured result using `qa-agent/python-regression-result/v1`.

Runtime validates every screenshot before generating the formal report, then embeds each screenshot beside the matching expected and actual checkpoint. The Agent must inspect those images and base its user-facing regression conclusion on the screenshot-backed report.

A completed result without screenshot-backed coverage for every source step is `invalid_result`. Runtime must not treat a screenshot-free execution as a valid regression report.

A business FAIL with `contractStatus=completed` means the steps are valid and the product behavior failed. Do not rewrite the steps automatically.
