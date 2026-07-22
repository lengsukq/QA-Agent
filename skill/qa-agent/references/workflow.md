# QA Agent Workflow

## Request classification

Use the main `qa-agent` Skill for ordinary AI-led checks, strict test matrices, release scope, script drafting/publication, and Runtime-owned Task work. Use `qa-agent-guided` when a human QA must approve each action and judge each observed result. Use `qa-agent-regression-test` only to run a Python script already published under a Task.

## Session continuity

`qa-agent check` creates or resumes a Task, writes its initial reviewable `prd.md`, and binds it to the current Session. It never starts a Run. `qa-agent continue` follows persisted Runtime state. `qa-agent finish` closes the Session pointer without silently archiving or deleting the Task.

## Shared PRD review gates

Both Quick and Guided modes use the same planning contract:

1. Create the Task through `qa-agent check`; use `--mode guided` for human-led execution.
2. Inspect relevant source, routes, configuration, tests, existing QA assets, and tools.
3. Build and apply a structured PlanDraft. Every Scenario must have ordered `steps`; every step needs an operation and expected result.
4. Present the complete Runtime-written Task PRD.
5. Resolve every `userQuestions` entry with the QA. Ask one concrete question at a time, store the answer under `confirmedDecisions`, remove the resolved question, and apply the updated PlanDraft again.
6. If the Agent has any material uncertainty not yet listed—requirements, environment, role, account, test data, expected behavior, or safety—it must add the question and stop.
7. Wait for the exact reply `确认测试方案`, then persist it with `qa-agent plan review`. This confirms that the PRD matches the QA requirement; it does not authorize UI execution.
8. Separately wait for the exact reply `确认开始测试`, then persist it with `qa-agent review`.
9. Only after both gates may `qa-agent test` create the Task's single Source Run or any UI tool be used.

Vague replies such as “可以”, “继续”, or “没问题” do not satisfy either planning gate.

## Daily Quick workflow

Quick mode is AI-led after both planning gates:

1. Call `qa-agent test` and wait for a Run ID with `uiExecutionAllowed=true`.
2. Execute the approved flow and persist every real UI action with a screenshot.
3. Record every declared business/visual assertion and Cleanup result.
4. Complete through `qa-agent run complete`.
5. Runtime writes `source-run/run.json`, `source-run/report.md`, screenshots, evidence, and the Task PRD result update.
6. When eligible, ask whether to generate a Python script draft from the exact completed Run.
7. Generation consent permits only draft creation. Show the complete script or diff and publish only after a separate script-publication approval.
8. Publication freezes the Source Run. Later regression uses `qa-agent-regression-test` and writes execution assets under `regression-runs/` without replanning or editing the formal script.

## Guided workflow

Guided mode is QA-led and uses `qa-agent check --mode guided`.

After both PRD gates and `qa-agent test`:

1. Propose exactly one next action and expected result.
2. Ask the QA whether to execute it. Persist approval with `qa-agent run guide-approve`, preferably using the matching PRD `--planned-step`.
3. Use a UI tool only after Runtime returns `uiExecutionAllowed=true`.
4. Execute only the approved action and persist it with `qa-agent run step`, including the real screenshot, actual locator, expected state, and actual state.
5. Present the observed result and ask whether it matches expectations.
6. Persist the QA's verdict with `qa-agent run guide-verdict`.
7. Do not execute another UI operation or complete the Run while a verdict is pending.

The QA may add a new action during execution. Record its explicit operation and expected result; do not silently alter an existing PRD expectation. A negative verdict remains a failure unless the QA later approves a new plan or retry. When the QA asks to save the Case, ensure every UI step has a human verdict, record all assertions and Cleanup, then complete through Runtime.

## Strict and release workflow

A fixed Scenario matrix, release scope, impact analysis, Release Gate, or GO/NO-GO remains part of the main `qa-agent` Skill. It uses the same PRD questions, `确认测试方案`, and separate `确认开始测试` gates. Task, Module, and Release regression select validated Python scripts directly.

## Session finish

Session finish and Task archive are different. Finish closes the active Session. Archive requires a complete Task definition, current approvals, a successful Source Run, validated Python coverage, regression results, evidence, Cleanup, and no unresolved known-issue candidates.

## User-visible language

Use goal, plan, question, progress, observed result, QA verdict, evidence, script, and next decision. Hide internal Module, Task, Scenario, Run, hash, gate, token, and file-path details unless requested.

## Safety boundaries

Never invent a Run step, screenshot, locator, assertion, Cleanup result, human decision, script approval, or regression result. Do not publish a draft without separate human approval. Do not edit a formal script merely to make a failing regression pass.
