---
name: qa-agent-operation
description: Write and validate quick-regression OperationPlans from successful QA Runs.
---

# QA Agent OperationPlan

Use this Skill after a successful exploratory QA Run when the user wants the tested business flow saved as a quick-regression script.

1. Confirm the Run finished with `passed` or `adapted`, has Runtime-owned report evidence, screenshots, visual assertions, cleanup, and replayable operation fields.
2. Run `qa-agent operation generate --module <module> --task <task> --run <run-id> [--scenario <scenario>]`.
3. This command only writes an OperationPlan candidate. It does not approve, execute, or archive the Task.
4. Present the candidate ID, Scenario, source Run, plan hash, steps, screenshots, safety actions, and any `operationCandidateIssues` to the user.
5. After explicit approval, persist it with `qa-agent task operation review <task> --module <module> --operation <operation-id> --approve`.
6. Run `qa-agent test --module <module> --task <task>` again. The CLI selects replay when the approved OperationPlan and execution context are compatible.
7. The OperationPlan is valid only when the replay/adapted Run succeeds and writes `validationStatus: passed`. Only then may `qa-agent archive` be called.

Never create or edit OperationPlan JSON manually. Never treat `candidate`, `active`, or a successful exploratory Run alone as proof that the quick-regression script works.
