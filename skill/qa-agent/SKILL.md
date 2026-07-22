---
name: qa-agent
description: Run project-aware QA checks, preserve real evidence, and turn reviewed successful flows into command-line Python regression scripts.
---

# QA Agent

Use this Skill for ordinary QA work. The user should only need to describe what to test, review the generated Task PRD, explicitly reply “确认开始测试”, say “continue”, or ask to finish.

Read `references/workflow.md` before acting. Runtime owns Task state, Run state, evidence, reports, safety decisions, Python script publication, and regression results.

## Route the request

- Informational question: answer directly without creating QA assets.
- Ordinary test or verification: use `qa-agent check`.
- Interruption, recovery, or “continue”: use `qa-agent continue`.
- Explicit session end: use `qa-agent finish`.
- Strict pre-execution matrix or release planning: load `qa-agent-plan`.
- Rerun an already approved Python script: load `qa-agent-regression-test`.
- Python draft generation, review, and publication remain in this main Skill.

Quick Check is the default. Do not force strict planning onto a one-off test.

## Daily workflow

1. Infer safe Module and Task identities, then call `qa-agent check --request "<original request>"`. It creates planning assets only and must not start a Run.
2. Inspect relevant source, routes, tests, configuration, existing QA assets, and tools.
3. Produce a PlanDraft. Every Scenario must contain ordered `steps`; every step needs `action` and `expected`.
4. Apply it through `qa-agent plan apply`. Runtime writes Scenario sections and Step / Operation / Expected Result tables to Task `prd.md`.
5. Present the current Task PRD without replacing it with a competing summary.
6. Require the exact reply `确认开始测试`; “可以”, “继续”, and similar replies are not approval.
7. Record it with `qa-agent review --module MODULE --task TASK --approve --confirmed-by HUMAN --confirmation-text "确认开始测试"`.
8. Then call `qa-agent test` to create or resume the Task's single Source Run. Before approval, never create it or invoke UI tools.
9. On later turns call `qa-agent continue`; do not request internal IDs again.
10. Use UI tools only with `uiExecutionAllowed=true`, `mustStop=false`, and a `runId`.
11. Persist each real action, screenshot, observation, cleanup, evidence artifact, and recovery attempt through Runtime.
12. Follow `nextAction`; ask at most one user-owned question per turn.
13. Complete only through `qa-agent run complete`. Runtime owns the report and Task PRD result section.
14. Present outcome, checks, failures or blockers, screenshots, and cleanup.
15. When `pythonRegressionEligibility.eligible=true`, ask whether to generate Python from that exact Run.
16. Generation consent authorizes a draft only. Read `references/python-regression.md` and `references/recommended-regression-stack.md`, generate from recorded steps, save with `qa-agent regression draft`, and show the full script or diff.
17. Publish with `qa-agent regression publish` only after separate explicit approval. Publication freezes the Source Run.
18. For reruns, load `qa-agent-regression-test`; it writes to `regression-runs/` and reviews the Runtime report without editing or replanning.
19. Call `qa-agent finish` only on explicit closure. Session finish is not Task archive.

## User-facing rules

Hide internal IDs, hashes, gates, tokens, paths, and protocol fields unless troubleshooting or explicitly requested.

## Safety

Never fabricate screenshots, evidence, results, locators, approvals, scripts, or reports. Stop before real payments, refunds, production writes or deletion, notification delivery, production permission changes, unavailable capabilities, execution-contract drift, or an unresolved business decision.
