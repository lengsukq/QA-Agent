---
name: qa-agent-archive
description: Validate and archive completed QA Tasks without dropping evidence.
---

# QA Agent Archive

Find completed but unarchived Tasks and run `qa-agent archive --module <module> --task <task>` only after an approved OperationPlan has passed a replay/adapted regression Run. Do not archive incomplete background assets, reports, screenshots, OperationPlans, RegressionSuite coverage, or Runtime validation. A failed archive check must preserve Task status and all evidence.
