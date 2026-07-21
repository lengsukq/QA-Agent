---
name: qa-agent-operation
description: Review and promote Runtime-generated OperationPlan candidates; explicit generation is compatibility-only.
---

# OperationPlan Promotion

The Runtime automatically generates eligible candidates after a successful exploratory Run. Do not manually create or edit OperationPlan JSON.

Present the candidate's Scenario, source Run, planHash, structured steps, locators, input references, expected states, checkpoints, screenshot policy, safety actions, and issues. After explicit human approval, use `qa-agent task operation review ... --approve --confirmed-by <human>`. The lifecycle becomes `approved_unverified`; run `qa-agent test` for real validation. Only `validated` plans are formal regression assets.

`qa-agent operation generate` remains available only to repair or migrate an older Run whose automatic candidate materialization did not occur.
