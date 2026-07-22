# QA Agent Workflow

## Request classification

Use the main `qa-agent` Skill for ordinary checks, script drafting, script review, script publication, and Runtime-owned Task work. Use `qa-agent-plan` only for strict pre-execution planning. Use `qa-agent-regression-test` only to run a Python script that is already published under a Task.

## Session continuity

`qa-agent check` creates or resumes a Task and binds it to the current Session. `qa-agent continue` follows the persisted Runtime state. `qa-agent finish` closes the Session pointer without silently archiving or deleting the Task.

## Daily Quick workflow

1. Read the project and propose a concise business test flow.
2. Wait for lightweight user approval before starting UI execution.
3. Start through `qa-agent check` or `qa-agent test`.
4. Persist every real UI action with a screenshot.
5. Record declared visual assertions and Cleanup results.
6. Complete through `qa-agent run complete`.
7. Runtime writes `run.json`, `report.md`, screenshots, evidence, and the Task PRD update.
8. Runtime evaluates whether the completed Run can safely become a Python regression source.
9. If eligible, the Agent may ask whether to generate a script draft.
10. The user’s first confirmation permits only draft generation.
11. The Agent writes Python from the exact recorded Run and saves it through `qa-agent regression draft`.
12. Show the complete script or complete diff, environment variables, host bridge requirements, assertions, screenshots, and Cleanup.
13. Wait for a second explicit approval.
14. Publish through `qa-agent regression publish` only after that review.
15. Later regression uses `qa-agent-regression-test`, which runs the existing script and reviews the Runtime report without replanning steps.

## Strict workflow

Use `qa-agent-plan` when the user explicitly requests a fixed Scenario matrix, strict release scope, or GO/NO-GO planning. The user must approve the TestPlan before real UI execution. Once Python scripts have been reviewed and validated, Task, Module, and Release regression select those scripts directly.

## Session finish

Session finish and Task archive are different. Finish closes the active Session. Archive requires complete Task definition, current approval where required, successful source Runs, validated Python coverage, regression results, evidence, Cleanup, and no unresolved known-issue candidates.

## User-visible language

Use goal, progress, result, evidence, script, and next decision. Hide internal Module, Task, Scenario, Run, hash, gate, token, and file-path details unless requested.

## Safety boundaries

Never invent a Run step, screenshot, locator, assertion, Cleanup result, script approval, or regression result. Do not publish a draft without separate human approval. Do not edit a formal script merely to make a failing regression pass.
