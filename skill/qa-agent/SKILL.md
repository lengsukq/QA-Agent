---
name: qa-agent
description: Plan, safely execute, verify, report, and retain project-level QA work in a local `.qa-agent/` memory boundary. Use when a user asks to initialize QA automation for a project; understand business modules; create or plan long-lived test tasks; execute a browser, mobile, API, or source-assisted business test; collect evidence; record a regression; store a business rule or user correction; assess missing MCP or local QA capabilities; or generate a QA run report.
---

# QA Agent

Use this skill as a local-first QA operating system. Treat real business results as the source of truth; source code only assists diagnosis.

## Architecture boundary

This Skill uses the `qa-agent/v2` contract. It is the QA brain, not a browser or simulator framework. It decides what to test, why it matters, what evidence is necessary, and how to classify the result. The host Agent and its approved MCPs perform clicks, typing, screenshots, recordings, simulator/device control, logs, data reads, source reads, and issue creation. The optional local Playwright adapter is a development/reference capability only; do not treat it as the required execution architecture.

## Agent-guided live QA

Do not reduce a business request to a static test-case runner. Use the available browser, Android simulator, iOS Simulator, or device tool to carry out the workflow as a QA engineer would:

1. Load the business goal, relevant project memory, module rules, role, environment, and safe-mode policy. First generate reviewable test cases that state business logic, data/preconditions, scenarios, expected results, visual assertions, evidence, and stop conditions. Wait for the user's explicit confirmation before marking the Task ready or opening the target UI.
2. After confirmation, start an Agent-guided Run, then inspect the real rendered screen before choosing an action. Make the next action conditional on the observed state.
3. For every real UI action (click, input, swipe, back, launch, reset, or navigation), save a screenshot for the report. Do not invoke visual recognition for every screenshot by default: inspect key business assertions, amounts, permissions, status/result changes, unexpected pages, locator adaptations, and final state. Label `Screenshot captured`, `Visual inspection performed`, and `Visual inspection not required` separately.
4. Record every meaningful operation and visual observation with its expected result, actual rendered result, status, and screenshot. Use DOM, network, logs, or source only as corroborating evidence.
5. For a later regression, enter fast replay only when the approved Task hash, user approval, active Scenario-specific OperationPlan, platform/device/app version, environment/role, test-data fingerprint, MCP health, and verified macOS permissions all match. Replay structured steps in order, keep business assertions, and use `ADAPTED` only when a safe semantic/accessibility locator adaptation preserves the business meaning. Otherwise return to plan confirmation or capability setup.
6. Stop on a risky action or missing capability, preserve the current Run as `paused` or `blocked`, and explain what is needed to resume. After an operation failure, wait, refresh/back, restart the app, reset sandbox data, reconnect MCP, use a fallback locator, or resume from a checkpoint. Never modify source code, bypass permissions, touch production, or fake results. Use `inconclusive` when evidence cannot support a verdict, `not_applicable` when the scenario does not apply to the current context, and `needs_confirmation` when the expected business rule itself needs user confirmation.
7. Complete the Run only after each scenario has business evidence; curate a failed result into a reviewable project-memory candidate and a successful first run into a candidate OperationPlan for later review. An adapted replay creates a versioned candidate that supersedes the prior plan only after review.

For Android or iOS, follow the same process with simulator/device screenshots and accessibility hierarchy. Before an APP run, call `qa-agent mobile doctor --platform android|ios`; require `android.adb` + `android.screenshot`, or `ios.simulator.interact` + `ios.screenshot`. If either is absent, create a BLOCKED run and ask the user to approve connecting or installing the least-privilege Android/iOS Simulator, ADB, or Appium MCP; state the requested permissions and validation steps, and do not install it automatically.

Run this workflow automatically when the user asks to execute a test. Do not ask the user to click through the UI, capture screenshots, enter Run steps, assess visual results, or generate the report. The Agent performs those actions and returns the final report. Ask the user only to confirm generated test cases before any execution, for unavailable credentials, an explicit high-risk approval, a missing required capability, or a business rule that cannot be inferred safely.

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
- Use Task for what to verify; use an approved OperationPlan under the Task's project-local `operations/` directory for how to replay a stable flow. Use Skill for reusable operation capability, never for project memory.
- Save reusable project skills under `.qa-agent/skills/generated/` only after a successful repeated operation and explicit user approval.

## Execute and verify

1. Convert the selected Task into a plan with prerequisites, data preparation, scenarios, capability requirements, evidence, cleanup, and stop conditions. Prefer Agent-guided interaction for business QA: operate the real browser, simulator, or device; inspect what is rendered; adapt the next action to the observed state.
   For browser scenarios, persist a deterministic runbook: `navigate`, `click`, `fill`, `assert-visible`, `assert-hidden`, `assert-text`, `assert-url`, `wait-for`, or `screenshot`. Give every tool action a structured locator, fallback locators, expected state, assertion references, screenshot policy, and `safetyAction`.
2. Check capabilities before any external action. Required gaps create a `BLOCKED` run, not a pass or a guessed result.
3. Verify the environment, platform, role, page state, and unique element locator before acting. Prefer test id, accessibility role/name, label, visible text, stable attribute, CSS, XPath, then coordinates. DOM inspection supports a conclusion but never replaces checking the rendered business result.
4. Capture a screenshot after every real UI action. Inspect only the adaptive checkpoints required by the Task evidence policy (baseline, key business state, failure/exception, locator adaptation, and final result); record whether visual inspection was performed or not required.
5. Use `run start`/`run replay`, `run step`, `run observe`, `run recover`, and `run complete` to preserve the real interaction trail. Replay `run step` calls must reference the next `operationStepId`; a visual observation must name the Scenario, assertion, expected business result, actual rendered result, status, and screenshot.
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
npm run qa-agent -- task create checkout-basic-flow --module checkout
npm run qa-agent -- task plan checkout-basic-flow --module checkout
npm run qa-agent -- task runbook checkout-basic-flow --module checkout --file checkout-runbook.json
npm run qa-agent -- task run checkout-basic-flow --module checkout
npm run qa-agent -- memory add checkout-total-rule --module checkout --title "Total rule" --content "..."
npm run qa-agent -- memory review checkout-total-rule --module checkout --approve
npm run qa-agent -- source diagnose --module checkout --query "payment selector"
  npm run qa-agent -- run start checkout-basic-flow --module checkout
  npm run qa-agent -- task operation list checkout-basic-flow --module checkout
  npm run qa-agent -- task operation review checkout-basic-flow --module checkout --operation OPERATION_ID --approve
  npm run qa-agent -- run replay checkout-basic-flow --module checkout --operation OPERATION_ID
  npm run qa-agent -- run step run-... --action "Tap checkout" --detail "Checkout page opened" --screenshot /absolute/path/step.png --visual-inspection not-required
  npm run qa-agent -- run recover run-... --reason "Element was not ready" --action "Wait for network" --detail "Element appeared after 2s" --outcome continued
npm run qa-agent -- run observe run-... --scenario happy-path --assertion business-outcome --expected "..." --actual "..." --status passed --screenshot /absolute/path.png
npm run qa-agent -- run complete run-...
npm run qa-agent -- index rebuild
```
