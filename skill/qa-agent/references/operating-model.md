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

## Visual verification protocol

For Agent-guided QA, screenshots are not decorative artifacts. Take and inspect them at these checkpoints:

1. Baseline before the workflow or state transition
2. Immediately after each consequential user operation
3. At every business assertion
4. On failure, interruption, or unexpected UI state

For each checkpoint, record what was expected by the business rule, what is visibly rendered, the conclusion, and the screenshot path. Compare rendered values, labels, enabled/disabled controls, permissions, error/success feedback, and state transitions. Do not infer a visual result solely from a successful click, DOM property, network response, or source branch.

Use deterministic Playwright runbooks for stable repeated flows. Use Agent-guided interaction whenever the workflow requires discovery, login context, simulator control, adaptive navigation, image/OCR judgement, or a business outcome that cannot be reduced safely to selectors.

The Run lifecycle is internal automation: the Agent starts it, controls the UI, records observations, completes it, and presents the generated report. Do not transfer these operational steps to the user.

## Source-assisted diagnosis

Use `qa-agent source search` or `qa-agent source diagnose` only after observing a business result. Source output is an `investigation_hint`, not a confirmed cause. The local verifier searches only the configured read-only source root and excludes `.qa-agent` and `node_modules`.

## Memory curation

Save only durable, scoped knowledge: business rules, workflows, permissions, state transitions, environment differences, known issues, regression notes, user corrections, stable test setup, source references, and safety constraints.

Each record should include type, module (when applicable), scope, source, confidence, knowledge level, importance, status, version, and timestamps. Reject secrets and unsupported claims. Detect duplicates and conflicts before writing; preserve superseded records rather than silently overwriting them.
