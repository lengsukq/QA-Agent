# QA operating model

## Evidence order

Use this order when conclusions conflict:

1. Observed business outcome in the target environment
2. UI state and declared business rule
3. API, logs, and data evidence
4. Read-only source diagnosis
5. Suggested code change

State explicitly when a conclusion is blocked, inferred, or needs confirmation.

## Required task shape

A Test Task needs a stable ID, module ID, scope, objectives, preconditions, scenarios, required capabilities, safety stop conditions, evidence requirements, and regression triggers. A Scenario describes business intent and expected state; a Step records a deterministic action during a Run. Before any external action, present the generated cases and business logic to the user and store explicit approval in the Task. A ready Task without approval must be BLOCKED.

## Capability decisions

Match generic capability names instead of hardcoding a specific MCP:

- `browser.interact`, `browser.inspect`, `network.read`
- `source.readonly`, `logs.read`, `database.readonly`
- `android.adb`, `android.screenshot`, `ios.simulator.interact`, `ios.screenshot`

Required missing capability: create a BLOCKED run and recommend a scoped solution. For APP testing, explicitly ask the user to approve connecting/installing the least-privilege Android Emulator/ADB or iOS Simulator/Appium MCP; never auto-install it or grant write access. Optional missing capability: run without it and disclose reduced evidence.

## Tool execution record

Use the host Agent's browser, mobile, network, log, or source tools for the actual operation. Before each action, append a Run Step with its intent; after it, record observed state and link each artifact under `.qa-agent/evidence/<run-id>/`. Save the following minimum evidence for a failed browser scenario:

- screenshot or recording;
- URL and page title;
- current visible text or accessibility snapshot;
- failing request, console error, or trace when available;
- exact expected-versus-actual assertion.

Do not call a tool merely because a task says it might be useful. Use only the lowest-privilege capability needed by the scenario, and keep blocked runs resumable.

## Task and Module fast regression replay

Replay uses the `qa-agent/v2` contract and is allowed only when the Task RegressionSuite, or the Module aggregate dynamically built from active Task OperationPlans, is current; Task approval and plan hash are current; each Scenario-specific OperationPlan is active and derived from that hash; the platform/environment/role/device/app version and test-data fingerprint are compatible; and the host-attested capabilities plus permissions are `verified`. Load the Task business logic and expected results, check preconditions, then have the host execute the selected OperationPlan steps in stable order. Replay skips rediscovery, not business assertions. `run.json` records results; OperationPlan is the replay contract.

Task assets are project-local and co-located under `modules/<module>/tasks/<task>/`: requirements, module snapshot, test plan, scenarios, operation-plans, RegressionSuite, runs, reports, evidence, and task-local memory candidates. Module regression dynamically aggregates active Task OperationPlans rather than persisting a second Suite. Independent failures continue to the next member; global capability or permission failures block the aggregate.

Release regression begins with a persisted ImpactAnalysis. Match changed files against module ids, source hints, entry points, dependencies, Task triggers, and tags; preserve unmatched files and selection reasons. The `fast` profile includes release gates, Golden Paths, every-release Tasks, and impacted P0 work. `normal` expands through impacted P1 work. `full` includes every active approved OperationPlan. Release selection never bypasses Task approval, OperationPlan preflight, business assertions, or screenshot evidence. A ReleaseCheck persists the selected Suite, RegressionRun id, blockers, and final GO, NO-GO, or REVIEW decision. Release reports reference child Task reports instead of copying their evidence.

After every real UI action, capture a screenshot for the report. Invoke visual recognition adaptively for key assertions, amounts, permissions, state/result changes, unexpected screens, locator adaptations, failures, and the final state. Reports must distinguish `Screenshot captured`, `Visual inspection performed`, and `Visual inspection not required`.

Before completion, enumerate every selected Scenario assertion and record each through `run observe`; a passed Step, including an assert Step, is not a Scenario verdict. Premature completion is rejected while the Run remains resumable. After a passed or adapted first Run, generate a candidate only when replay steps are structurally complete: explicit actions, target locators, structured redacted input references, state expectations, screenshots, and assertion evidence. Otherwise persist `operationCandidateIssues` and report that business verification passed but replay readiness did not.

If a step fails, inspect the current state and use only safe recovery within the Task limits: wait, refresh/back, restart the app, reset sandbox data when allowed, reconnect the MCP, use a semantic/accessibility fallback locator, or resume from a checkpoint. Never modify source code, bypass permissions, operate production, or fabricate a result. Record original failure → diagnosis → recovery action → outcome → business conclusion. A semantically successful locator adaptation yields `ADAPTED` and a versioned candidate OperationPlan; a material flow or business-rule change yields `NEEDS_CONFIRMATION`.

## Visual verification protocol

For Agent-guided QA, screenshots are not decorative artifacts. Capture one after every real UI action, but inspect them only at these adaptive checkpoints:

1. Baseline before the workflow or state transition
2. Immediately after each consequential user operation (all other action screenshots remain evidence without immediate visual inspection)
3. At every business assertion
4. On failure, interruption, or unexpected UI state

For each checkpoint, record what was expected by the business rule, what is visibly rendered, the conclusion, and the screenshot path. Compare rendered values, labels, enabled/disabled controls, permissions, error/success feedback, and state transitions. Do not infer a visual result solely from a successful click, DOM property, network response, or source branch.

Use approved OperationPlans for stable repeated flows. The host Agent selects and invokes its own browser, simulator, and diagnostic tools; the runtime records their outputs and enforces the QA contract.

The Run lifecycle is internal automation: the Agent starts it, controls the UI, records observations, completes it, and presents the generated report. Do not transfer these operational steps to the user.

## Source-assisted diagnosis

Use the host's approved read-only source tool only after observing a business result. Submit findings to the active Run as `source-diagnosis` evidence. Source output is an `investigation_hint`, not a confirmed cause.

## Memory curation

Save only durable, scoped knowledge: business rules, workflows, permissions, state transitions, environment differences, known issues, regression notes, user corrections, stable test setup, source references, and safety constraints.

Each record should include type, module (when applicable), scope, source, confidence, knowledge level, importance, status, version, and timestamps. Reject secrets and unsupported claims. Detect duplicates and conflicts before writing; preserve superseded records rather than silently overwriting them.
