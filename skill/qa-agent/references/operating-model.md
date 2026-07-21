# QA operating model

## Evidence order

1. Observed business outcome in the target environment
2. UI state and declared business rule
3. API, logs, and data evidence
4. Read-only source diagnosis
5. Suggested code change

State explicitly when a conclusion is blocked, inferred, adapted, stale, or needs confirmation.

## Workflow model

```text
start / discovery
→ Scenario matrix and requirement trace
→ review and explicit TestPlan approval
→ preflight gates
→ test execution and screenshots
→ assertions, cleanup, and recovery
→ Runtime report and automatic OperationPlan candidate
→ separate OperationPlan promotion approval
→ real replay validation
→ validated RegressionSuite
→ archive
```

Task lifecycle, current workflow phase, Run result, Gate state, and OperationPlan lifecycle are separate fields. Runtime returns a compact breadcrumb, structured `nextActions`, `resumeToken`, and `contextHash` on every workflow status response.

## OperationPlan lifecycle

```text
candidate → approved_unverified → validated
                 └──────────────→ stale
candidate → rejected
validated → superseded | stale
```

Only `validated` plans may enter formal RegressionSuites, release checks, or archive gates. Candidate generation is Runtime-owned and automatic after an eligible exploratory Run.

## Event and state authority

Every durable transition appends a task-local `events.jsonl` record with sequence, actor, reason code, artifact hash, and idempotency key. Indexes are projections and may be rebuilt. The Agent must never edit event logs or indexes directly.

## Execution gate

No UI tool may run before `uiExecutionAllowed=true`, `mustStop=false`, and a `runId` are returned. A passed Step is not a Scenario verdict. Record each declared assertion through `run observe`, each Cleanup outcome through `run cleanup`, and each recovery through `run recover` before Runtime completion.

## Context and recovery

Before asking the user, inspect relevant source, tests, configuration, reviewed memory, historical Runs, and OperationPlans. Ask at most one user-owned decision per turn. Resume interrupted work only when Runtime context hash, approval, environment, test data, capabilities, and OperationPlan remain compatible.

## Safety and memory

Stop before real payment, refund, deletion, production writes, real notifications, and production permission changes. Never store credentials or raw production data. Durable memory must be reviewed, scoped, evidence-backed knowledge rather than raw chat or transient tool failures.
