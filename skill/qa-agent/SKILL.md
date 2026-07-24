---
name: qa-agent
description: Run project-aware QA checks, preserve real evidence, and turn reviewed successful flows into replayable regression steps.
---

# QA Agent

Use this Skill for AI-led QA work. The user describes what to test; the Agent analyzes the project, produces a reviewable PRD, executes the approved flow, and preserves Runtime-owned evidence and reports.

Read `references/workflow.md` before acting. Runtime owns Task state, Run state, evidence, reports, safety decisions, approvals, Python publication, and regression results.

## Route the request

- Informational question: answer directly without QA assets.
- Ordinary AI-led check: `qa-agent check`.
- User-led, step-by-step execution: load `qa-agent-guided` and use `qa-agent check --mode guided`; Runtime generates one draft per Scenario on completion.
- Interruption or “continue”: `qa-agent continue`.
- Explicit session end: `qa-agent finish`.
- Run an already approved Python script: load `qa-agent-regression-test`.
- Fixed release scope, test matrix, GO/NO-GO, and impact planning remain in this main Skill and Runtime release commands.

## Required planning gates

1. Create or resume the Task with `qa-agent check --request "<request>"`. This creates planning assets only; it must not start a Run.
2. Inspect relevant source, routes, tests, configuration, existing QA assets, and tools.
3. Produce and apply a PlanDraft. Every Scenario requires ordered `steps`, each with `action` and `expected`.
4. Present the complete Runtime Task PRD with its clickable `userFacingArtifacts[].markdownLink`; never substitute a plain path.
5. If `userQuestions` exist—or the Agent has any material uncertainty about requirements, environment, account, test data, expected behavior, or safety—ask the QA one concrete question at a time. Persist answers in `confirmedDecisions`, clear resolved questions, and reapply the PlanDraft.
6. Ask whether the PRD matches the requested requirements. Persist only the exact reply `确认测试方案` through `qa-agent plan review`.
7. Then require a separate exact reply `确认开始测试`, persisted through `qa-agent review`.
8. Only after both gates may `qa-agent test` create the Task's single Source Run or any UI tool be used.

Do not treat “可以”, “继续”, or “没问题” as either PRD confirmation or start authorization.

## Execution and result

1. Use `qa-agent act` commands for all UI interactions. Never use external browser/device tools directly.
2. Each `act` command auto-screenshots and auto-records. No manual step reporting needed.
3. Record every declared business/visual assertion via `qa-agent act assert-text` or `act assert-visible`.
4. Once all assertions and Cleanup are recorded, call `qa-agent run complete` in the same turn. NEVER end a turn while a Run remains `running`.
5. Follow `nextAction`; ask at most one user-owned question per turn.
6. Use only the Runtime report. Formal reports must embed real screenshots with Markdown image syntax. Include clickable report and finalized PRD links.
7. After completion, if eligible, Runtime exports regression steps automatically. Publish with `qa-agent regression publish` only after separate explicit approval.
8. Reruns use `qa-agent-regression-test` and `regression-runs/`. Formal regression reports embed every checkpoint screenshot.
9. Call `qa-agent finish` only on explicit closure. Session finish is not Task archive.

## Safety

Never fabricate screenshots, evidence, results, locators, approvals, scripts, or reports. Stop before real payments, refunds, production writes or deletion, notification delivery, production permission changes, unavailable capabilities, execution-contract drift, or unresolved business decisions.
