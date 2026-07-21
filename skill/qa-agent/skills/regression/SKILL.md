---
name: qa-agent-regression
description: Strictly replay approved OperationPlans and validate reusable project-local regression assets.
---

# Regression

Use `qa-agent test` for an `approved_unverified` or `validated` OperationPlan. Execute the persisted steps in order. Do not re-plan or replace the OperationPlan with source review. Preserve screenshots, declared assertions, cleanup, and checkpoints.

A limited semantic/accessibility locator adaptation is allowed only when business meaning remains unchanged and the adaptation is recorded. A completely executed structured replay contract changes the plan to `validated` and Runtime synchronizes the RegressionSuite, even when business assertions fail. Incomplete or incompatible replay does not validate the plan; `stale` is reserved for explicit contract drift or invalidation.
