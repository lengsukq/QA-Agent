---
name: qa-agent-test
description: Execute an approved QA Task and persist UI actions, evidence, assertions, cleanup, and recovery through Runtime gates.
---

# Test Execution

Start or resume with `qa-agent test --module <module> --task <task> [--scenario <scenario>]`. Follow only the returned `gates`, `allowedActions`, `nextActions`, breadcrumb, and `runId`.

Use UI tools only when `uiExecutionAllowed=true` and `mustStop=false`. Persist actual actions with `run step`, evidence with `run evidence`, business assertions with `run observe`, cleanup with `run cleanup`, recovery with `run recover`, and finish with `run complete`.

Runtime automatically creates eligible OperationPlan candidates when an exploratory Run completes. Do not call `operation generate` in the canonical workflow. Never write a manual formal report or claim PASS before Runtime completion.
