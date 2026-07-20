# QA operating model

## Source of truth

1. Observed business outcome
2. Declared expectations and rendered state
3. API, data, logs, and traces
4. Read-only source diagnosis

## State machine

```text
workflow bootstrap
→ Module and Task directory
→ Test Plan
→ human approval
→ task explore or operation replay returns uiExecutionAllowed=true + mustStop=false + runId
→ UI steps and screenshots
→ assertions
→ cleanup
→ run complete
→ report and OperationPlan readiness
```

No UI tool may run before the explicit execution gate. If Runtime returns BLOCKED, NEEDS_CONFIRMATION, or mustStop=true, stop rather than bypassing preflight. Mirror the workflow `todoList` into the host IDE TodoList, but treat `.qa-agent` data as the authoritative state. Formal Task reports are generated only under runs/<run-id>/report.md; manual global reports are invalid.

## Task and Run storage

A Task is the long-lived QA asset. Each Run is one self-contained package:

```text
Task/
├── task.json
├── requirements.json
├── test-plan.json
├── scenarios/
├── operation-plans/
├── regression-suite.json
└── runs/<run-id>/
    ├── run.json
    ├── report.md
    ├── screenshots/
    └── evidence/
```

## Verification

Every real UI action requires a screenshot. Every declared business assertion requires `run observe`; every declared cleanup requires `run cleanup`. A passed Step is not a passed Scenario. Non-visible facts require API, data, or log evidence.

Human-assisted or blocked system steps remain valid evidence but are not fully automated replay assets.

## Release

Impact Analysis selects scope but never replaces business verification. Missing P0/release-gate OperationPlans are `NO-GO`; other required gaps are `REVIEW`. Aggregate reports reference child Run reports rather than copying their evidence.
