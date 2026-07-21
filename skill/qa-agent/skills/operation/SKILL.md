---
name: qa-agent-operation
description: Review and promote Runtime-generated OperationPlan candidates; explicit generation is compatibility-only.
---

# OperationPlan Promotion

The Runtime automatically generates eligible candidates after a successful exploratory Run. Do not manually create or edit OperationPlan JSON.

An OperationPlan is a persisted, Scenario-specific and repeatable business operation path, not a requirement for fully autonomous Agent execution. Each plan belongs to its owning Task and is stored under `.qa-agent/modules/<module>/tasks/<task>/operation-plans/<scenario>/`; do not create or move it into a standalone project-level script directory. It fixes the ordered actions, locators, inputs, expected states, assertions, evidence, and cleanup. A person, an Agent assisting a person, or a dedicated executor such as Playwright, Python plus fb-idb, or ADB may perform the path. Every replay must begin from the application's home page or defined initial entry point with the approved initial state restored or confirmed. After the path is approved, do not rediscover, start from an intermediate page, or redesign the business flow.

Present the candidate's Scenario, source Run, planHash, structured steps, locators, input references, expected states, checkpoints, screenshot policy, safety actions, and issues. After explicit human approval, use `qa-agent task operation review ... --approve --confirmed-by <human>`. The lifecycle becomes `approved_unverified`; run `qa-agent test` for real validation. Only `validated` plans are formal regression assets.

`qa-agent operation generate` remains available only to repair or migrate an older Run whose automatic candidate materialization did not occur.
