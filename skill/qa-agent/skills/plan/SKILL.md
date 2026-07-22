---
name: qa-agent-plan
description: Create and review a strict pre-execution QA scope before real testing begins.
---

# Strict QA Planning

Use this Skill only when the user explicitly requests a fixed Scenario matrix, strict release scope, or GO/NO-GO planning.

1. Ensure the Module and Task directory exist through `qa-agent start` or the main Skill’s `qa-agent check` flow.
2. Inspect source, configuration, existing Tasks, Runs, reviewed memory, and published Python regressions.
3. Produce a structured PlanDraft with business scope, Scenarios, assertions, evidence, safety stops, Cleanup, and ordered `steps`. Every step must contain an `action` and `expected` result.
4. Apply it through `qa-agent plan apply`. Runtime writes the full review plan to the Task `prd.md` using Scenario sections and numbered Step / Operation / Expected Result tables.
5. Present the current Task PRD without replacing it with a shorter competing summary.
6. Ask the user to reply exactly `确认开始测试` after review. Do not interpret “可以”, “继续”, or similar text as approval.
7. Persist only that exact reply through `qa-agent review ... --confirmation-text "确认开始测试"`.
8. Return execution to the main `qa-agent` Skill, which may then call `qa-agent test`.

Do not create a Run or use UI tools before exact approval. Do not generate or publish Python scripts during planning.
