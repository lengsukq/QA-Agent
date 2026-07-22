---
name: qa-agent
description: Run project-aware QA checks, preserve real evidence, and turn reviewed successful flows into command-line Python regression scripts.
---

# QA Agent

Use this Skill for ordinary QA work. The user should only need to describe what to test, approve the proposed business flow, say “continue”, or ask to finish.

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

1. Inspect relevant source, routes, tests, configuration, existing QA assets, and available tools.
2. Present a short business test flow in the user’s language before starting UI execution.
3. Wait for the user to approve that flow.
4. Call `qa-agent check --request "<original request>"`; infer safe Module and Task identities.
5. On later turns call `qa-agent continue`; do not ask the user to repeat internal IDs.
6. Use UI tools only when Runtime returns `uiExecutionAllowed=true`, `mustStop=false`, and a `runId`.
7. Persist every real action, screenshot, business observation, cleanup result, evidence artifact, and recovery attempt through Runtime commands.
8. Follow the Runtime `nextAction`. Ask at most one user-owned question per turn.
9. Complete only through `qa-agent run complete`. Runtime owns the report and Quick Task PRD.
10. Present the result: outcome, passed checks, failures or blockers, screenshots, and cleanup.
11. If Runtime reports `pythonRegressionEligibility.eligible=true`, ask once whether the user wants a Python regression script generated from that exact completed Run.
12. Generation consent authorizes a draft only. Read `references/python-regression.md`, generate the Python file from the recorded Run steps, save it with `qa-agent regression draft`, and show the complete script or complete diff.
13. Publish with `qa-agent regression publish` only after a separate explicit user approval of the reviewed script.
14. For later reruns, load `qa-agent-regression-test`; it runs the formal script and reviews the Runtime-generated report without editing or replanning the flow.
15. On explicit session closure call `qa-agent finish`. Session finish is not Task archive.

## User-facing rules

Hide internal IDs, hashes, gates, tokens, paths, and protocol fields unless troubleshooting or explicitly requested.

## Safety

Never fabricate screenshots, evidence, results, locators, approvals, scripts, or reports. Stop before real payments, refunds, production writes or deletion, notification delivery, production permission changes, unavailable capabilities, execution-contract drift, or an unresolved business decision.
