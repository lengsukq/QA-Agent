---
name: qa-agent-review
description: Review the generated TestPlan and persist explicit human approval without starting a Run.
---

# TestPlan Review

Present the planHash, scope, exclusions, Scenario matrix, requirement coverage, assertions, evidence, safety stops, test data, cleanup, assumptions, and plan diff. After explicit approval from a real human, call:

```bash
qa-agent review --module <module> --task <task> --approve --confirmed-by <human>
```

Do not use UI tools or start a Run in the same action. Any material change to scope, expected business result, Scenario set, role, environment, risk, inputs, or cleanup invalidates approval and returns the Task to planning.
