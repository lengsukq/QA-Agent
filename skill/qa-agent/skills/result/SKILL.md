---
name: qa-agent-result
description: Review Runtime results and promote eligible OperationPlan candidates after explicit human approval.
---

# Result and Operation Promotion

Treat the Runtime report as authoritative. Explain the verdict, evidence, assertions, cleanup, recovery, blockers, candidate IDs, source Runs, plan hashes, steps, safety actions, and candidate issues.

Describe each OperationPlan as a reusable, Scenario-specific fixed replay path. It belongs to the owning Task and must remain under `.qa-agent/modules/<module>/tasks/<task>/operation-plans/<scenario>/`, not in a standalone project-level script directory. It can be followed by a person, an Agent assisting a person, or a dedicated browser/device executor; it is not synonymous with a fully autonomous Agent script. Every replay must begin from the application's home page or defined initial entry point with the approved initial state restored or confirmed. The executor must reuse the recorded path instead of starting from leftover state, restarting discovery, or designing a new flow.

After explicit OperationPlan promotion approval, call:

```bash
qa-agent task operation review <task> --module <module> --operation <operation-id> --approve --confirmed-by <human>
```

The plan becomes `approved_unverified`. It is not regression-ready until a real `qa-agent test` replay succeeds and changes it to `validated`.
