---
name: qa-agent-result
description: Review Runtime results and promote eligible OperationPlan candidates after explicit human approval.
---

# Result and Operation Promotion

Treat the Runtime report as authoritative. Explain the verdict, evidence, assertions, cleanup, recovery, blockers, candidate IDs, source Runs, plan hashes, steps, safety actions, and candidate issues.

After explicit OperationPlan promotion approval, call:

```bash
qa-agent task operation review <task> --module <module> --operation <operation-id> --approve --confirmed-by <human>
```

The plan becomes `approved_unverified`. It is not regression-ready until a real `qa-agent test` replay succeeds and changes it to `validated`.
