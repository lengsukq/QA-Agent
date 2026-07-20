---
name: qa-agent-regression
description: Replay approved OperationPlans and run project-local QA regression suites.
---

# QA Agent Regression

Use only active, approved OperationPlans whose planHash and execution context are compatible. Run `qa-agent task regression sync` after OperationPlan approval, then execute `qa-agent task regression run`. Preserve screenshotPolicy, checkpoints, visual assertions, cleanup, and Runtime reports for every Scenario. Stop on stale hashes, missing capabilities, missing screenshots, or unsafe actions.
