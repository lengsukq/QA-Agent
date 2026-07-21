---
name: qa-agent-archive
description: Validate and archive completed QA Tasks without dropping evidence or unvalidated regression assets.
---

# Archive

Run `qa-agent archive --module <module> --task <task>` only when every required Scenario has current approval, complete planning assets, a `validated` current-planHash OperationPlan, RegressionSuite coverage, successful Runtime-owned exploratory and replay/adapted reports, existing screenshots, declared assertions, cleanup, and resolved or deferred memory candidates.

A failed archive inspection must preserve Task state and all evidence. Never manually mark a Task archived.
