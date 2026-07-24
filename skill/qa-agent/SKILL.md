---
name: qa-agent
description: Run project-aware QA checks, preserve real evidence, and turn reviewed successful flows into replayable regression steps.
---

# QA Agent

Use this Skill for AI-led QA. Analyze the project, produce a reviewable PRD, execute the approved flow, and preserve Runtime-owned evidence.

Before checks, or when uncertain, load `qa-agent-doctor` to verify the project and Runner.

Read `references/workflow.md` first. Runtime owns Task/Run state, evidence, safety, approvals, and results.

## Route the request

- Informational question: answer directly without QA assets.
- Ordinary AI-led check: `qa-agent check`.
- User-led, step-by-step execution: load `qa-agent-guided` and use `qa-agent check --mode guided`; Runtime generates one draft per Scenario on completion.
- Interruption or “continue”: `qa-agent continue`.
- Explicit session end: `qa-agent finish`.
- Run already approved JSON regression steps: load `qa-agent-regression-test`.

## Required planning gates

1. Create or resume the Task with `qa-agent check --request "<request>"`. This creates planning assets only; it must not start a Run.
2. Inspect relevant source, routes, configuration, QA assets, and tools.
3. Produce and apply a PlanDraft. Every Scenario requires ordered `steps`, each with `action` and `expected`.
4. Present the complete Runtime Task PRD with clickable `userFacingArtifacts[].markdownLink`.
5. Inspect source/configuration, entry points, installed targets, and capabilities to determine one platform: `web` or `ios`. Persist it in `PlanDraft.platformDeclaration`, set `declaredBy` to `qa-agent`, align `scope.platforms`, and reapply. Ask the QA only when evidence is ambiguous.
6. Resolve `userQuestions` and any material uncertainty one question at a time. Persist answers in `confirmedDecisions`, clear resolved questions, and reapply the PlanDraft.
7. Set `PlanDraft.executionIntent` explicitly to `read-only` or `state-changing`. Runtime computes `confirmationMode`: eligible ordinary read-only Tasks use `merged`; all other Tasks use `strict`.
8. For `merged`, ask only for the exact reply `确认测试并开始执行` and persist it through `qa-agent plan review`. For `strict`, persist `确认测试方案` through `qa-agent plan review`, then require `确认开始测试` through `qa-agent review`.
9. Only after the computed confirmation mode is satisfied and platform capabilities pass may `qa-agent test` create the Task's single Source Run or any UI tool be used.

Do not treat “可以”, “继续”, or “没问题” as PRD confirmation or start authorization. Do not manually edit `task.json` approval metadata; use Runtime/CLI commands.

## Execution and result

1. Web/iOS only. `qa-agent act` uses the built-in Runner server. Web: `navigate/click/fill/select/check/uncheck/get-text/upload/accept-dialog/dismiss-dialog/assert*/scroll/hover/wait/screenshot/key`; iOS: `launch/tap/type-text/fill/clear/toggle/get-text/accept-dialog/dismiss-dialog/assert*/swipe/scroll/back/home/describe/wait/screenshot/key`. Never call MCP or direct UI tools. Runner venv: `.qa-agent/venv/` (Doctor-created); Runtime resolves it automatically.
2. On mismatch, stop; run `qa-agent doctor --platforms <web|ios>`, reapply the correct Agent-inferred PlanDraft, repeat the computed confirmation, then run `qa-agent test --platform <web|ios>`. Ask only if the source remains ambiguous. Never use MCP as a bridge.
3. Each `act` command auto-screenshots and auto-records. When a step passes, Runtime backfills its `regressionStep` into the matching PlannedTestStep.
4. Record every declared business/visual assertion via `qa-agent act assert-text` or `act assert-visible`.
5. Once all assertions and Cleanup are recorded, call `qa-agent run complete` in the same turn. NEVER end a turn while a Run remains `running`.
6. Follow `nextAction`; ask at most one user-owned question per turn.
7. Use only the Runtime report; embed real screenshots with Markdown image syntax, never paths alone, and link report/PRD.
8. After completion, if eligible, Runtime exports only `.steps.json` regression steps. Publish with `qa-agent regression publish` only after separate explicit approval.
9. Reruns use `qa-agent-regression-test`; replay through `qa-agent regression run` and the unified Python Runner.
10. Call `qa-agent finish` only on explicit closure. Session finish is not Task archive.

## Safety

Never fabricate screenshots, evidence, results, locators, approvals, scripts, or reports. Stop before real payments, refunds, production writes or deletion, notification delivery, production permission changes, unavailable capabilities, execution-contract drift, or unresolved business decisions.
