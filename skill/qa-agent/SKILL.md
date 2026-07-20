---
name: qa-agent
description: Plan, safely execute, verify, report, and retain project-level QA work in a local `.qa-agent/` memory boundary. Use when a user asks to initialize QA for a project; understand business modules; create long-lived test tasks; execute browser or mobile business tests; collect screenshot evidence; replay regressions; analyze code-change impact; assess release readiness with fast, normal, or full profiles; store reviewed QA memory; assess missing host capabilities; or generate Task, Module, and Release reports.
---

# QA Agent

## CLI-first lifecycle

The host Skill is one entry point; the CLI owns configuration, state, execution, reports, and archiving. The host owns the conversation, TodoList mirror, human confirmation, and UI tools.

1. Run `qa-agent start --request "..." --module <module> --task <task>` and stop at `approval_required`.
2. Present the plan and wait for explicit user confirmation. Persist it through the internal `qa-agent task review ...` command.
3. Run `qa-agent test --module <module> --task <task> [--scenario <scenario>]`; it selects explore or replay automatically.
4. After a successful Runtime Run, run `qa-agent archive --module <module> --task <task>`; it verifies the complete Task package before archiving.

The compatibility commands `workflow bootstrap`, `task explore`, `task run`, `operation replay`, and `task archive` remain available for existing projects.

## CLI command reference

Use the CLI for all project and Task mutations. Do not manually create or edit the JSON/Markdown assets listed below.

| Command | Purpose | Starts UI Run? |
| --- | --- | --- |
| `qa-agent init` | Create the project `.qa-agent/` runtime boundary only. | No |
| `qa-agent configure --project PATH --host HOST` | Initialize a project if needed and inject the host Skill/Rule/Command. | No |
| `qa-agent doctor` | Show the host capabilities known to the project. | No |
| `qa-agent context module MODULE` | Load project, Module, Task, memory, policy, prompts, and capability context. | No |
| `qa-agent start --request TEXT --module MODULE --task TASK` | Create or reuse the Module and create the complete Task directory, planning assets, Scenarios, plan hash, and TodoList. Stops at `approval_required`. | No |
| `qa-agent task plan TASK --module MODULE` | Recalculate/display planning suggestions for an existing Task. It does not approve or run the Task. | No |
| `qa-agent task review TASK --module MODULE --approve --confirmed-by HUMAN` | Persist explicit human approval and mark the Task ready. This command never starts a Run. | No |
| `qa-agent test --module MODULE --task TASK [--scenario SCENARIO]` | Start the approved Task; automatically selects first-run explore or compatible replay. | Yes, only when the Runtime gate allows it |
| `qa-agent operation replay OPERATION --module MODULE --task TASK` | Compatibility/direct replay entry for an approved OperationPlan. | Yes, only when preflight allows it |
| `qa-agent run step/evidence/observe/cleanup/recover/complete RUN ...` | Internal Run persistence commands used by the host Agent to record actions, evidence, assertions, cleanup, recovery, and completion. | No; these continue an existing Run |
| `qa-agent task operation list/show/review ...` | List, inspect, or approve an OperationPlan candidate after a successful Run. | No |
| `qa-agent task regression sync/show/run/complete ...` | Build or execute a Task RegressionSuite from approved active OperationPlans. | `run` starts regression child Runs |
| `qa-agent impact analyze ...` | Map changed files to affected Modules and Tasks. | No |
| `qa-agent release check ...` | Build and optionally start an impact-aware release regression check. | Only without `--plan-only` and after gates pass |
| `qa-agent archive --module MODULE --task TASK` | Validate complete Task background, plans, OperationPlans, RegressionSuite, Runtime report, and screenshot evidence, then archive. | No |
| `qa-agent validate` | Validate project JSON, reports, OperationPlans, Runs, and indexes. | No |
| `qa-agent prompts sync` | Synchronize the five current mode prompts and remove obsolete prompt files. | No |
| `qa-agent index rebuild` | Rebuild project indexes after data changes or migration. | No |

The normal Agent path is exactly `start → review → test → archive`. `task create`, `workflow bootstrap`, `task explore`, and `task run` are lower-level compatibility commands; do not substitute them for `start` in a new host conversation.

Use this skill as a local-first QA operating system. Treat real business results as the source of truth; source code only assists diagnosis.

## Mandatory CLI state gate

1. Before presenting a plan, call `qa-agent start --request "..." --module <id> --task <id> ...` and verify that the response contains `bootstrap.taskDirectory`, `bootstrap.taskAssets`, `plan`, `planHash`, and `workflowStatus: approval_required`. This command creates the complete Task directory and its planning assets.
2. Mirror the returned `todoList` into the host IDE TodoList. Do not present a plan invented only in the conversation, and do not claim that a Task exists until the CLI has returned its Task directory.
3. Show the CLI-generated plan and wait for explicit approval from a real human reviewer. Approval must not start a Run.
4. After approval, call the internal persistence command `qa-agent task review <task> --module <id> --approve --confirmed-by <human>`. Verify that this response is a Task record with `metadata.status: ready`; do not call UI tools or a Run command in the same approval action.
5. Only after the user has approved and `task review` has completed, call `qa-agent test --module <id> --task <id>`. This is the sole semantic command that starts the Run. It returns `uiExecutionAllowed: true`, `mustStop: false`, and `runId` only when execution is allowed.
6. The compatibility commands `workflow bootstrap` and `task explore` are for existing automation only; do not use them as the host conversation's primary flow. If the response is `BLOCKED`, `NEEDS_CONFIRMATION`, or `mustStop: true`, stop immediately and follow only `next` or `nextAllowedAction`.

Read-only source exploration is allowed before approval only to refine the Test Plan. UI execution is not.

## Architecture boundary

This Skill uses the `qa-agent/v2` contract. It is the QA brain, not a browser or simulator framework. It decides what to test, why it matters, what evidence is necessary, and how to classify the result. The host Agent and its approved MCPs perform clicks, typing, screenshots, recordings, simulator/device control, logs, data reads, source reads, and issue creation. Before planning or execution, load `canonicalPrompts` from `qa-agent context module <module>` or the `task run` response. If the Prompt Bundle is missing or stale, run `qa-agent prompts sync` and stop until it is current. Import the host capability snapshot before a Run; `qa-agent` never connects those tools or validates their system permissions itself.

## Agent-guided live QA

Do not reduce a business request to a static test-case runner. Use the available browser, Android simulator, iOS Simulator, or device tool to carry out the workflow as a QA engineer would:

1. Load the business goal, relevant project memory, module rules, role, environment, and safe-mode policy. First generate reviewable test cases that state business logic, data/preconditions, scenarios, expected results, visual assertions, evidence, and stop conditions. Wait for explicit confirmation from a real human reviewer before marking the Task ready or opening the target UI. Never use `qa-agent`, `assistant`, `system`, `auto-approved`, or `unknown` as the approver; preserve the confirmation source.
2. After confirmation, start an Agent-guided Run, then inspect the real rendered screen before choosing an action. Make the next action conditional on the observed state.
3. For every real UI action (click, input, swipe, back, launch, reset, or navigation), save a screenshot for the report. Do not invoke visual recognition for every screenshot by default: inspect key business assertions, amounts, permissions, status/result changes, unexpected pages, locator adaptations, and final state. Label `Screenshot captured`, `Visual inspection performed`, and `Visual inspection not required` separately.
4. Record every meaningful operation and visual observation with its expected result, actual rendered result, status, and screenshot. Use DOM, network, logs, or source only as corroborating evidence.
5. For a later regression, load the Task RegressionSuite or dynamically build the Module aggregate from active Task OperationPlans. Enter fast replay only when its suite hash, approved Task hash, user approval, active Scenario-specific OperationPlan, platform/device/app version, environment/role, test-data fingerprint, and host-attested capability/permission snapshot all match. The Agent automatically iterates the selected members; the user must not be asked to enter individual `run step` commands. Replay structured steps in order, keep business assertions, and use `ADAPTED` only when a safe semantic/accessibility locator adaptation preserves the business meaning. Otherwise return to plan confirmation or capability setup.
6. Stop on a risky action or missing capability, preserve the current Run as `paused` or `blocked`, and explain what is needed to resume. After an operation failure, wait, refresh/back, restart the app, reset sandbox data, reconnect MCP, use a fallback locator, or resume from a checkpoint. Never modify source code, bypass permissions, touch production, or fake results. Use `inconclusive` when evidence cannot support a verdict, `not_applicable` when the scenario does not apply to the current context, and `needs_confirmation` when the expected business rule itself needs user confirmation.
7. Complete the Run only after each scenario has business evidence; curate a failed result into a reviewable project-memory candidate and a successful first run into a candidate OperationPlan for later review. An adapted replay creates a versioned candidate that supersedes the prior plan only after review.

For Android or iOS, follow the same process with simulator/device screenshots and accessibility hierarchy. Before an APP run, call `qa-agent host doctor --platform android|ios`; require `android.adb` + `android.screenshot`, or `ios.simulator.interact` + `ios.screenshot`. If either is absent, create a BLOCKED run and ask the user to approve connecting or installing the least-privilege Android/iOS Simulator, ADB, or Appium MCP; state the requested permissions and validation steps, and do not install it automatically.

Run this workflow automatically when the user asks to execute a test. Do not ask the user to click through the UI, capture screenshots, enter Run steps, assess visual results, or generate the report. The Agent performs those actions and returns the final report. Ask the user only to confirm generated test cases before any execution, for unavailable credentials, an explicit high-risk approval, a missing required capability, or a business rule that cannot be inferred safely.

## Run closure and OperationPlan quality

Treat Run completion as a strict protocol, not a report-writing shortcut:

1. Before `run complete`, load every selected Scenario and enumerate every declared `visualAssertions` id.
2. For each assertion, inspect the relevant screenshot and call `run observe` with Scenario, assertion id, expected result, actual rendered result, terminal status, and screenshot for passed, failed, or adapted outcomes.
3. A passed `run step` records execution only. Even `operationAction=assert` does not satisfy a business assertion and must never replace `run observe`.
4. Do not call `run complete` while any assertion or declared Scenario cleanup result is missing. After the final business observation, execute every declared cleanup action and persist its actual outcome with `run cleanup`. Cleanup failure cannot be hidden behind a business PASS. The runtime rejects premature completion and keeps the Run open so the missing observations can be recorded.
5. On a first successful Run, classify each meaningful step as `host-automated`, `user-assisted`, `system-component-blocked`, or `preseeded-test-data`. User-assisted and blocked system steps are valid evidence but cannot produce a fully automated replay contract. Make every replayable step structurally complete: explicit `operationAction`; planned or actual locator for navigate, click, input, and fill; structured redacted `inputRefs` for input/fill; expected and actual state; screenshot; and Scenario binding.
6. After `run complete`, inspect `status`, `operationCandidates`, and `operationCandidateIssues`. A passed business result with no candidate is valid QA evidence but is not fast-replay ready. Report the exact missing replay fields instead of producing a separate manual PASS report.
7. Review and approve a candidate OperationPlan before adding it to a RegressionSuite.

For initialized projects created with an older QA-Agent version, run `qa-agent prompts sync` so obsolete planning prompts are removed and `.qa-agent/prompts/` contains only `start.md`, `test.md`, `review.md`, `archive.md`, and `report.md`.

## Release regression

When the user asks whether a build can be released, use the release workflow rather than manually selecting unrelated Tasks:

1. Run `impact analyze` against the working tree or the requested Git range. Preserve unmatched files and explain every module and Task selection; filename matching is a risk signal, not confirmed business impact.
2. Build the release scope from approved active OperationPlans and inspect `requiredAssetGaps`. A P0 or release-gate Task without an active approved OperationPlan is `NO-GO`; another required Golden Path or every-release gap is `REVIEW`, never silently omitted. A Task marked `releaseGate`, tagged `golden-path`, or configured with `every-release` frequency remains in the release scope even when no direct file impact is resolved.
3. Use `fast` for global release gates and Golden Paths plus impacted P0 flows, `normal` to expand through impacted P1 flows, and `full` for all active approved OperationPlans.
4. Start the release regression with `release check`. Complete child Runs with the same screenshot and visual-assertion requirements as normal replay, then call `release complete` to produce GO, NO-GO, or REVIEW.
5. A failed business assertion is NO-GO. A blocked or unconfirmed P0/release-gate flow is also NO-GO. Safe locator adaptation produces REVIEW until its candidate OperationPlan is reviewed.
6. The Release report must reference each Task report and its evidence without duplicating all screenshots.

## Start safely

1. Locate `.qa-agent/project.json` from the working directory upward. Load only that project's `.qa-agent/` data. Before drafting a new Task, use approved read-only source/search tools to understand routes, components, APIs, permissions, and state transitions when that context can improve the plan. Treat source discoveries as inferred planning context, never as confirmed business truth.
   For a module task, run `qa-agent context module <module-id>` to load the Project, business goals, confirmed memories, existing Tasks, Skills, capabilities, and safety policy as one context snapshot.
2. If no project exists, inspect the repository root and run `npm run qa-agent -- init` only after the user asks to initialize it.
3. Before planning or running a task, load the Project, relevant Module, Task, Memory, policies, and capabilities. Do not infer facts from another project or Git branch.
4. Use `npm run qa-agent -- doctor` to expose capability gaps. Explain missing capabilities and least-privilege options; never install or connect an MCP without the user's confirmation.

Install this Skill once through the matching host integration, then initialize each tested project separately with `qa-agent init`. Use `qa-agent install-host codex`, `claude`, `cursor`, `opencode`, `copilot`, `gemini`, or `agents`; `qa-agent install-skill` remains the Codex-compatible alias.

An IDE/user-level installation contains only reusable instructions. Never put business rules, credentials or their references, Tasks, Runs, screenshots, evidence, reports, or reviewed Memory in a global host directory. Keep every project fact and artifact inside the active project's `.qa-agent/` boundary.

## Plan and persist work

Use the hierarchy `Project → Module → Test Task → Scenario → Run → Step`.

- Create modules as stable business boundaries.
- Treat module planning as non-mutating output. Cover core flows, boundaries, roles, state transitions, exceptions, consistency, idempotency, dependencies, and historic regressions.
- Create or modify a Test Task only after the intended scenarios and expected results are clear. Use project Memory, Module facts, and read-only source context to generate business rules, normal/boundary/permission/state/exception/idempotency/cross-module scenarios, visual assertions, and required evidence. Present the generated test cases and business logic for explicit user confirmation; use `task review --approve --confirmed-by <user>` only after that confirmation. Approval is tied to the generated plan hash: any material test-plan change invalidates approval and requires a new user confirmation, while an unchanged approved version may run repeatedly without asking again.
- Use Task for what to verify; use an approved OperationPlan under the Task's project-local `operation-plans/<scenario>/` directory for how to replay a stable flow. Treat `run.json` as a result record, never as an executable script. Persist Task RegressionSuite files only; derive Module regression from active Task OperationPlans. Use Skill for reusable operation capability, never for project memory.
- Keep the complete Task asset set together: `task.json`, `module-snapshot.json`, `requirements.json`, `test-plan.json`, `scenarios/`, `operation-plans/`, `regression-suite.json`, `runs/`, `reports/`, and task-local memory candidates.
- Save reusable project skills under `.qa-agent/skills/generated/` only after a successful repeated operation and explicit user approval.

## Execute and verify

1. Convert the selected Task into a plan with prerequisites, data preparation, scenarios, capability requirements, evidence, cleanup, and stop conditions. Every state-mutating Scenario must declare cleanup that restores the account, role, and test-data baseline before another Scenario or replay. Prefer Agent-guided interaction for business QA: use the host's real browser, simulator, or device tools; inspect what is rendered; adapt the next action to the observed state.
2. Check capabilities before any external action. Required gaps create a `BLOCKED` run, not a pass or a guessed result.
3. Verify the environment, platform, role, page state, and unique element locator before acting. Prefer test id, accessibility role/name, label, visible text, stable attribute, CSS, XPath, then coordinates. DOM inspection supports a conclusion but never replaces checking the rendered business result.
4. Capture a screenshot after every real UI action. Inspect only the adaptive checkpoints required by the Task evidence policy (baseline, key business state, failure/exception, locator adaptation, and final result); record whether visual inspection was performed or not required.
5. Use `qa-agent test --module <module> --task <task>` to start a single Task interaction trail. The host then uses the Runtime's `run step`, `run evidence`, `run observe`, `run cleanup`, `run recover`, and `run complete` operations internally. Never create `task.json`, Scenario files, plans, or reports one by one from the Agent; `qa-agent start` is the one-shot Task package creation command.
6. Compare actual results with the Task's explicit expectations. Mark outcomes as passed, failed, adapted, blocked, paused, or needs_confirmation; never manufacture a passing result. Generate a Markdown report and retain only its evidence paths in the Run.

When using Agent-guided mode, invoke the Run lifecycle commands yourself as part of execution; they are persistence operations for the Agent, not instructions for the user to carry out.

Read [operating model](references/operating-model.md) when creating a task, reviewing an execution, or curating memory.

## Safety and memory

- Respect `.qa-agent/policies.json` at all times. Stop before real payment, refund, deletion, production writes, real notifications, and production permission changes. Request approval for configured gated actions.
- Do not save passwords, tokens, cookies, private keys, payment data, or unredacted production data in JSON, reports, or evidence. Store only secret references such as `env:QA_BUYER_PASSWORD`.
- Default source and database access to read-only. Never modify source, commit, push, or alter production configuration while testing unless the user separately requests it.
- Curate durable facts rather than chat transcripts. After a passed, evidence-backed visual run, automatically create an `observed` candidate for its key business outcome; after a failed run, automatically create a known-issue candidate. Keep both inside the project boundary and require review before promotion to active project knowledge. Mark new observations as `observed`, inferences as `inferred`, and unverified claims as `suspected`. Require confirmation before promoting an important inferred rule to `confirmed`.
- When a user corrects a business rule, create a candidate memory, identify conflicts and impacted Tasks, then ask for confirmation before replacing existing confirmed knowledge.

## MVP commands

```bash
npm run qa-agent -- init
npm run qa-agent -- module create checkout --name "Checkout" --description "Order settlement"
npm run qa-agent -- module plan checkout
npm run qa-agent -- start --request "Validate Checkout" --module checkout --task checkout-basic-flow
npm run qa-agent -- task plan checkout-basic-flow --module checkout
npm run qa-agent -- memory add checkout-total-rule --module checkout --title "Total rule" --content "..."
npm run qa-agent -- memory review checkout-total-rule --module checkout --approve
  npm run qa-agent -- host import --file /absolute/path/host-capabilities.json
  npm run qa-agent -- test --module checkout --task checkout-basic-flow
  npm run qa-agent -- task operation list checkout-basic-flow --module checkout
  npm run qa-agent -- task operation review checkout-basic-flow --module checkout --operation OPERATION_ID --approve
  npm run qa-agent -- task regression sync checkout-basic-flow --module checkout
  npm run qa-agent -- task regression run checkout-basic-flow --module checkout
  npm run qa-agent -- module regression run checkout --priority p1
  npm run qa-agent -- impact analyze --base origin/main --head HEAD
  npm run qa-agent -- release check --profile fast --base origin/main --head HEAD --plan-only
  npm run qa-agent -- release check --profile fast --base origin/main --head HEAD
  npm run qa-agent -- release complete RELEASE_CHECK_ID
  npm run qa-agent -- test --module checkout --task checkout-basic-flow --scenario happy-path
  npm run qa-agent -- run step run-... --action "Tap checkout" --detail "Checkout page opened" --operation-action click --locator-strategy accessibility --locator-value "Checkout" --expected-state "Checkout page is visible" --actual-state "Checkout page is visible" --screenshot /absolute/path/step.png --visual-inspection not-required
  npm run qa-agent -- run step run-... --action "Fill checkout" --detail "Entered reviewed test data" --operation-action fill --locator-strategy accessibility --locator-value "Checkout form" --input-refs email=fixture:buyer-email,address=fixture:shipping-address --expected-state "Required fields contain test data" --actual-state "Required fields contain test data" --screenshot /absolute/path/form.png --visual-inspection not-required
  npm run qa-agent -- run evidence run-... --type console --summary "Host console output" --file /absolute/path/console.log
  npm run qa-agent -- run recover run-... --reason "Element was not ready" --action "Wait for network" --detail "Element appeared after 2s" --outcome continued
npm run qa-agent -- run observe run-... --scenario happy-path --assertion business-outcome --expected "..." --actual "..." --status passed --screenshot /absolute/path.png
npm run qa-agent -- run complete run-...
npm run qa-agent -- index rebuild
```
