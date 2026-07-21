---
name: qa-agent
description: Plan, execute, verify, replay, report, and archive project-level QA through the local qa-agent Runtime and project-scoped `.qa-agent/` memory.
---

# QA Agent

QA Agent is a thin workflow router. The CLI Runtime owns persistent state, transitions, approvals, evidence, reports, OperationPlans, regression assets, and archive gates. The host Agent owns the conversation and approved UI/MCP tools.

## Canonical lifecycle

```text
start → review → test → result/promotion → test regression → archive
```

Use only these semantic entry commands in a normal conversation:

```bash
qa-agent start --request "..." --module <module> --task <task>
qa-agent review --module <module> --task <task> --approve --confirmed-by <human>
qa-agent test --module <module> --task <task> [--scenario <scenario>]
qa-agent archive --module <module> --task <task>
```

`workflow bootstrap`, `task explore`, `task run`, `operation replay`, `operation generate`, `task review`, and `task archive` are compatibility or administration commands. Do not select them as the primary next action. Compatibility responses may include `deprecatedAlias` and `canonicalCommand`.

## Per-turn state gate

At the start of every turn, read the latest Runtime `WorkflowState` and its compact `<qa-workflow-state>` breadcrumb. Treat these fields as authoritative:

- `taskState`
- `workflowPhase`
- `gates`
- `allowedActions`
- `forbiddenActions`
- `nextActions`
- `resumeToken`
- `contextHash`

Do not use UI tools unless `uiExecutionAllowed=true`, `mustStop=false`, and a `runId` exists. Never bypass a blocking Gate. The compatibility fields `workflowStatus` and `nextAllowedAction` may be read, but `nextActions` is preferred.

## Phase routing

| Condition | Load |
| --- | --- |
| No Task or incomplete intake | `skills/start/SKILL.md` |
| Planning or TestPlan approval | `skills/review/SKILL.md` |
| Approved Task or active Run | `skills/test/SKILL.md` |
| Completed Run or candidate promotion | `skills/result/SKILL.md` |
| Approved-unverified or validated replay | `skills/regression/SKILL.md` |
| Blocked, paused, interrupted, or stale context | `skills/recovery/SKILL.md` |
| All completion assets are ready | `skills/archive/SKILL.md` |

Load only the current phase instructions instead of carrying the full workflow in every prompt.

## Responsibility boundary

The Agent may:

- inspect project source and existing QA assets with read-only tools;
- ask for user-owned product, scope, role, environment, risk, test-data, or side-effect decisions;
- present plans, diffs, Runtime results, and candidates;
- invoke semantic Runtime commands and allowed Run persistence actions;
- operate approved browser, simulator, device, and MCP tools.

The Runtime alone may:

- change durable workflow state;
- validate approvals and plan hashes;
- open and complete formal Runs;
- generate authoritative reports;
- automatically create OperationPlan candidates from eligible exploratory Runs;
- validate OperationPlans through real replay;
- build formal regression assets and enforce archive gates.

Never manually write Task manifests, Scenario JSON, OperationPlan JSON, formal Run reports, event logs, or indexes.

## Planning behavior

Before asking a question, inspect the relevant Module, Task, source, tests, configuration, reviewed memory, historical Runs, existing OperationPlans, environment, and capability snapshot. Ask at most one highest-value user decision per turn. State why it matters, give the recommended answer, and explain the effect of alternatives.

Task creation is non-destructive and can happen automatically. Human approval is required for the TestPlan business contract, high-risk actions, OperationPlan promotion, and any user-owned decision that cannot be safely inferred.

## Approval separation

TestPlan approval authorizes execution of the unchanged planHash. It does not approve a reusable regression script.

OperationPlan approval promotes a Runtime-generated `candidate` to `approved_unverified`. A completely executed structured replay contract changes it to `validated`, even when the Run correctly reports a business FAIL; the FAIL remains a Run result. Only `validated` OperationPlans may enter formal RegressionSuites, release gates, or satisfy archive requirements.

## Execution and evidence

Persist every real UI action with a screenshot. Record declared business assertions through `run observe`; a passed `run step` never substitutes for an assertion. Record every declared cleanup outcome. Keep recovery attempts and evidence in the same Run package.

Stop on real payment, refund, production deletion/write, real notification, production permission changes, missing capabilities, missing permissions, stale approval, incompatible environment, or unsafe action. Do not fabricate evidence, results, locators, or reports.

## Memory

Keep project facts and artifacts inside the active project's `.qa-agent/` directory. Never persist credentials, secrets, raw production data, or unreviewed chat transcripts. Promote only reviewed, stable business rules or known defects to durable memory.
