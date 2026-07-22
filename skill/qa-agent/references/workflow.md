# QA Agent Workflow

## Request classification

Use the main `qa-agent` Skill for ordinary checks, script drafting, script review, script publication, and Runtime-owned Task work. Use `qa-agent-plan` only for strict pre-execution planning. Use `qa-agent-regression-test` only to run a Python script that is already published under a Task.

## Session continuity

`qa-agent check` creates or resumes a Task, writes its initial reviewable `prd.md`, and binds it to the current Session. It never starts a Run. `qa-agent continue` follows the persisted Runtime state. `qa-agent finish` closes the Session pointer without silently archiving or deleting the Task.

## Daily Quick workflow

1. Call `qa-agent check` to create or resume the Task directory. No Run or UI action is allowed at this stage.
2. Inspect the relevant source, routes, configuration, existing QA assets, and available tools.
3. Build a structured PlanDraft. Every Scenario must have ordered `steps`; every step must include an operation and expected result.
4. Apply the PlanDraft. Runtime persists Scenario JSON and writes the current plan into Task `prd.md` using numbered Step / Operation / Expected Result tables.
5. Present the Task PRD to the user for review.
6. Wait for the exact reply `确认开始测试`. Replies such as “可以”, “继续”, or “没问题” do not authorize execution.
7. Persist that exact reply through `qa-agent review ... --confirmation-text "确认开始测试"`.
8. Only then call `qa-agent test`. Runtime creates or resumes the Task's single Source Run and must return its Run ID with `uiExecutionAllowed=true` before the Agent uses a UI tool.
9. Persist every real UI action with a screenshot, then record declared visual assertions and Cleanup results.
10. Complete through `qa-agent run complete`.
11. Runtime writes `source-run/run.json`, `source-run/report.md`, screenshots, evidence, and the Task PRD result update.
12. Runtime evaluates whether the completed Source Run can safely become a Python regression source.
13. If eligible, the Agent may ask whether to generate a script draft. That confirmation permits only draft generation.
14. The Agent writes Python from the exact recorded Run and saves it through `qa-agent regression draft`.
15. Show the complete script or complete diff, environment variables, host bridge requirements, assertions, screenshots, and Cleanup.
16. Wait for a separate script-publication approval, then publish through `qa-agent regression publish`.
17. Later regression uses `qa-agent-regression-test`, which runs the existing script and reviews the Runtime report without replanning steps.

Before script publication, a new initial test may replace the existing Source Run; Runtime records `source_run_restarted` instead of creating exploratory Run history. After publication, the Source Run is frozen and later execution must use `regression-runs/`. A changed TestPlan first marks the old script `stale`, after which a newly approved plan may produce a replacement Source Run.

## Strict workflow

Use `qa-agent-plan` when the user explicitly requests a fixed Scenario matrix, strict release scope, or GO/NO-GO planning. It must create detailed Scenario steps, apply them, and write them into the Task PRD before requesting approval. The same exact `确认开始测试` gate applies to Quick and strict Tasks. Once Python scripts have been reviewed and validated, Task, Module, and Release regression select those scripts directly.

## Session finish

Session finish and Task archive are different. Finish closes the active Session. Archive requires a complete Task definition, current approval, a successful Source Run, validated Python coverage, regression results, evidence, Cleanup, and no unresolved known-issue candidates.

## User-visible language

Use goal, progress, result, evidence, script, and next decision. Hide internal Module, Task, Scenario, Run, hash, gate, token, and file-path details unless requested.

## Safety boundaries

Never invent a Run step, screenshot, locator, assertion, Cleanup result, script approval, or regression result. Do not publish a draft without separate human approval. Do not edit a formal script merely to make a failing regression pass.
