---
name: qa-agent-regression
description: Strictly replay approved OperationPlans and validate reusable project-local regression assets.
---

# Regression

Use `qa-agent test` for an `approved_unverified` or `validated` OperationPlan. An OperationPlan is a fixed, Scenario-specific replay path that may be executed manually, with Agent assistance, or by a dedicated executor such as Playwright, Python plus fb-idb, or ADB. Begin every replay from the application's home page or defined initial entry point, restoring or confirming the approved initial state before executing the persisted steps in order. Do not rely on leftover navigation or data, rediscover the UI, re-plan, skip or duplicate steps, or replace the OperationPlan with source review. Preserve screenshots, declared assertions, cleanup, and checkpoints.

A limited semantic/accessibility locator adaptation is allowed only when business meaning remains unchanged and the adaptation is recorded. A completely executed structured replay contract changes the plan to `validated` and Runtime synchronizes the RegressionSuite, even when business assertions fail. Incomplete or incompatible replay does not validate the plan; `stale` is reserved for explicit contract drift or invalidation.
