---
name: qa-agent
description: Run project-aware QA checks, preserve real evidence, and turn reviewed successful flows into replayable regression steps.
---

# QA Agent

Use this Skill for AI-led QA. Analyze the project, produce a reviewable PRD, execute the approved flow, and preserve Runtime-owned evidence.

Before checks, or when uncertain, load `qa-agent-doctor` to verify the project, Runner, Python, and selected Web/iOS adapter.

Read `references/workflow.md` first. Runtime owns Task/Run state, evidence, reports, safety, approvals, regression publication, and results.

## Route the request

- Informational question: answer directly without QA assets.
- Ordinary AI-led check: `qa-agent check`.
- User-led, step-by-step execution: load `qa-agent-guided` and use `qa-agent check --mode guided`; Runtime generates one draft per Scenario on completion.
- Interruption or “continue”: `qa-agent continue`.
- Explicit session end: `qa-agent finish`.
- Run already approved JSON regression steps: load `qa-agent-regression-test`.

## Required planning gates

1. Create or resume the Task with `qa-agent check --request "<request>"`. This creates planning assets only; it must not start a Run.
2. Inspect relevant source, routes, tests, configuration, QA assets, and tools.
3. Produce and apply a PlanDraft. Every Scenario requires ordered `steps`, each with `action` and `expected`.
4. Present the complete Runtime Task PRD with clickable `userFacingArtifacts[].markdownLink`.
5. After presenting the generated plan, ask the QA to explicitly declare exactly one platform: `web` (Web) or `ios` (iOS Simulator). Persist it as `PlanDraft.platformDeclaration.platform`, make `scope.platforms` contain the same single platform, and reapply the PlanDraft. Do not infer this declaration from the project default.
6. Resolve `userQuestions` and any material uncertainty one question at a time. Persist answers in `confirmedDecisions`, clear resolved questions, and reapply the PlanDraft.
7. Ask whether the PRD matches the requested requirements. Persist only the exact reply `确认测试方案` through `qa-agent plan review`.
8. Then require a separate exact reply `确认开始测试`, persisted through `qa-agent review`.
9. Only after the platform declaration and both approval gates may `qa-agent test` create the Task's single Source Run or any UI tool be used.

Do not treat “可以”, “继续”, or “没问题” as either PRD confirmation or start authorization.

## Execution and result

1. Web/iOS only. `qa-agent act` uses the built-in Runner server. Web: `navigate/click/fill/select/assert/scroll/hover/wait/screenshot`; iOS: `launch/tap/type-text/swipe/describe/assert/wait/screenshot`. Never call MCP or direct UI tools.
2. On a platform mismatch, stop; run `qa-agent doctor --platforms <web|ios>`, ask the QA to declare the target platform, reapply the correct PlanDraft with `platformDeclaration`, repeat normal confirmations, then run `qa-agent test --platform <web|ios>`. Never use MCP as a bridge.
3. Each `act` command auto-screenshots and auto-records. No manual step reporting needed.
4. Record every declared business/visual assertion via `qa-agent act assert-text` or `act assert-visible`.
5. Once all assertions and Cleanup are recorded, call `qa-agent run complete` in the same turn. NEVER end a turn while a Run remains `running`.
6. Follow `nextAction`; ask at most one user-owned question per turn.
7. Use only the Runtime report; embed real screenshots with Markdown image syntax, never paths alone, and link report/PRD.
8. After completion, if eligible, Runtime exports only `.steps.json` regression steps. Publish with `qa-agent regression publish` only after separate explicit approval.
9. Reruns use `qa-agent-regression-test`; replay always goes through `qa-agent regression run` and the unified Python Runner.
10. Call `qa-agent finish` only on explicit closure. Session finish is not Task archive.

## Safety

Never fabricate screenshots, evidence, results, locators, approvals, scripts, or reports. Stop before real payments, refunds, production writes or deletion, notification delivery, production permission changes, unavailable capabilities, execution-contract drift, or unresolved business decisions.
