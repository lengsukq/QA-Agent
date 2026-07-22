---
name: qa-agent-plan
description: Create and review a strict pre-execution QA scope before real testing begins.
---

# Strict QA Planning

Use this Skill only when the user explicitly requests a fixed Scenario matrix, strict release scope, or GO/NO-GO planning.

1. Inspect source, configuration, existing Tasks, Runs, reviewed memory, and published Python regressions.
2. Produce a structured PlanDraft with business scope, Scenarios, assertions, evidence, safety stops, and Cleanup.
3. Apply it through `qa-agent plan apply`.
4. Present a concise human-readable plan and request explicit approval.
5. Persist approval through `qa-agent review`.
6. Return execution to the main `qa-agent` Skill.

Do not run UI actions before approval. Do not generate or publish Python scripts during planning.
