# QA Agent Workflow

## Request classification

Use the main `qa-agent` Skill for ordinary AI-led checks, strict test matrices, release scope, regression steps export/publication, and Runtime-owned Task work. Use `qa-agent-guided` when a human QA must approve each action and judge each observed result. Use `qa-agent-regression-test` only to run regression steps already published under a Task.

## Session continuity

`qa-agent check` creates or resumes a Task, writes its initial reviewable `prd.md`, and binds it to the current Session. It never starts a Run. `qa-agent continue` follows persisted Runtime state. `qa-agent finish` closes the Session pointer without silently archiving or deleting the Task.

## Shared PRD review gates

Both Quick and Guided modes use the same planning contract:

1. Create the Task through `qa-agent check`; use `--mode guided` for human-led execution.
2. Inspect relevant source, routes, configuration, tests, existing QA assets, and tools.
3. Build and apply a structured PlanDraft. Every Scenario must have ordered `steps`; every step needs an operation and expected result.
4. Present the complete Runtime-written Task PRD and include its Runtime-provided clickable `userFacingArtifacts[].markdownLink` in the same reply.
5. After the plan is generated, inspect source, configuration, entry points, installed targets, and capabilities to determine exactly one platform. Put `web` or `ios` in `PlanDraft.platformDeclaration.platform`, set `declaredBy` to `qa-agent`, make `scope.platforms` contain the same single platform, and apply the updated PlanDraft again. Ask the QA only when evidence leaves multiple platforms or no platform candidate.
6. Resolve every `userQuestions` entry with the QA. Ask one concrete question at a time, store the answer under `confirmedDecisions`, remove the resolved question, and apply the updated PlanDraft again.
7. If the Agent has any material uncertainty not yet listed—requirements, environment, role, account, test data, expected behavior, or safety—it must add the question and stop.
8. Set `PlanDraft.executionIntent` explicitly. If Runtime reports `confirmationMode=merged`, wait for `确认测试并开始执行` and persist it with `qa-agent plan review`; this records both plan review and start authorization. Otherwise wait for `确认测试方案`, persist it with `qa-agent plan review`, then separately wait for `确认开始测试` and persist it with `qa-agent review`.
9. Only after the computed confirmation mode and host capabilities pass may `qa-agent test` create the Task's single Source Run or any UI tool be used.

Vague replies such as “可以”, “继续”, or “没问题” do not satisfy the computed confirmation gate. Runtime/CLI writes `task.json`; the Agent must not edit approval metadata manually.

## Daily Quick workflow

Quick mode is AI-led after the computed confirmation gate:

1. Call `qa-agent test` and wait for a Run ID with `uiExecutionAllowed=true`.
2. Execute the approved flow using `qa-agent act` commands (navigate, click, fill, assert-text, etc.). Each command auto-screenshots and auto-records.
3. Record every declared business/visual assertion via `qa-agent act assert-text` or `act assert-visible`, and Cleanup result.
4. Complete through `qa-agent run complete`. This step is mandatory in the same turn once all assertions and Cleanup are recorded; the Agent must not end the conversation while the Run is still `running`.
5. Runtime writes `source-run/run.json`, `source-run/report.md`, screenshots, evidence, and the Task PRD result update. `report.md` must embed every recorded screenshot using Markdown image syntax. The user-facing completion reply must include clickable links for both `report.md` and the finalized `prd.md`.
6. When eligible, Runtime automatically exports regression steps from the completed Run. Publish with `qa-agent regression publish` only after separate explicit approval.
7. Publication freezes the Source Run. Later regression uses `qa-agent-regression-test` and writes execution assets under `regression-runs/`. A formal regression report must embed every validated checkpoint screenshot in Markdown.

## Guided workflow

Guided mode is QA-led and uses `qa-agent check --mode guided`.

After the strict PRD gates and `qa-agent test`:

1. Propose exactly one next action and expected result.
2. Ask the QA whether to execute it. Persist approval with `qa-agent run guide-approve`, preferably using the matching PRD `--planned-step`.
3. Use `qa-agent act` commands only after Runtime returns `uiExecutionAllowed=true`.
4. Execute only the approved action via `qa-agent act` (auto-screenshots and auto-records).
5. Present the observed result and ask whether it matches expectations.
6. Persist the QA's verdict with `qa-agent run guide-verdict`.
7. Do not execute another UI operation or complete the Run while a verdict is pending.

The QA may add a new action during execution. Record its explicit operation and expected result; do not silently alter an existing PRD expectation. A negative verdict remains a failure unless the QA later approves a new plan or retry. Runtime persists only the current pending interaction; completed approvals and verdicts live on their Step. When the QA asks to save the Case, ensure every UI step has both records, record all assertions and Cleanup, then MUST complete through `qa-agent run complete` in the same turn. Completion automatically exports regression steps for every selected Scenario. Present all Scenario regression links.

## Strict and release workflow

A fixed Scenario matrix, release scope, impact analysis, Release Gate, or GO/NO-GO remains part of the main `qa-agent` Skill. It uses the same PRD questions, `确认测试方案`, and separate `确认开始测试` gates. Task, Module, and Release regression select validated regression steps directly.

## Session finish

Session finish and Task archive are different. Finish closes the active Session. Archive requires a complete Task definition, current approvals, a successful Source Run, validated regression coverage, regression results, evidence, Cleanup, and no unresolved known-issue candidates.

## User-visible language

Use goal, plan, question, progress, observed result, QA verdict, evidence, script, and next decision. Hide internal Module, Task, Scenario, Run, hash, gate, token, and unrelated file-path details unless requested. Always surface the Runtime-provided clickable PRD and report artifact links at their review/completion points; never replace them with plain paths.

## Safety boundaries

Never invent a Run step, screenshot, locator, assertion, Cleanup result, human decision, regression approval, or regression result. Do not publish regression steps without separate human approval. Do not edit published steps merely to make a failing regression pass.
