---
name: qa-agent
description: Plan, approve, execute, verify, replay, and report project-level QA work inside a local `.qa-agent/` boundary.
---

# QA Agent

Use `qa-agent/v2` as the QA state machine. The host IDE controls browser, simulator, device, and diagnostics; QA-Agent owns plans, approvals, evidence, reports, replay assets, and release decisions.

## Mandatory bootstrap gate

1. First call `qa-agent workflow bootstrap --request "..." --module <id> --task <id> ...`.
2. Mirror the returned `todoList` into the IDE TodoList when that tool exists.
3. Read the returned plan and show it to the user.
4. Wait for explicit approval from a real human reviewer. The Agent cannot approve its own plan.
5. Use `task explore` for the first approved execution. Use `operation replay` when an active OperationPlan already exists.
6. Do not use any browser, simulator, device, or UI tool unless the latest response contains both `uiExecutionAllowed: true` and `runId`.

Read-only source exploration is allowed before approval only to refine the Test Plan. UI execution is not.

## Run contract

- Record every real UI action with `run step` and a screenshot.
- `run step` records execution; it never replaces `run observe`.
- Record every declared assertion with `run observe`.
- Record every declared cleanup action with `run cleanup`.
- Use `user-assisted` for actual human intervention and `system-component-blocked` for uncontrollable system UI. Neither produces a fully automated OperationPlan.
- Call `run complete`, then inspect `status`, `operationCandidates`, and `operationCandidateIssues`.
- Never replace the runtime result with a manually written PASS report.

Each Run is self-contained:

```text
.qa-agent/modules/<module>/tasks/<task>/runs/<run-id>/
├── run.json
├── report.md
├── screenshots/
└── evidence/
```

Task plans, Scenarios, OperationPlans, RegressionSuite, and reviewed memory remain beside `runs/` in the same Task directory.

## Replay and release

Replay only active, approved OperationPlans in a compatible execution context. Replay is strict execution of JSON: do not regenerate a plan or review source code. Follow `nextOperationStep`, preserve business assertions and cleanup, and generate a new Run report with checkpoint screenshots.

Release checks begin with Impact Analysis. Missing P0 or release-gate replay assets are `NO-GO`; other required asset gaps are `REVIEW`. Return `GO`, `NO-GO`, or `REVIEW` from evidence.

## Safety

Stop before production writes, real payments/refunds, deletion, notifications, or permission changes. Do not store passwords, tokens, cookies, private keys, payment data, or unredacted production data. Never modify source code as part of a QA Run unless the user separately requests development work.
