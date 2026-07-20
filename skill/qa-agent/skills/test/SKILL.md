---
name: qa-agent-test
description: Create, continue, and execute approved QA Tasks through the qa-agent CLI.
---

# QA Agent Test

Use `qa-agent start` to create the complete Task package in one CLI call. Present the returned plan, planHash, Task directory, and TodoList; wait for explicit human approval. Persist approval with `qa-agent task review`, then use `qa-agent test` to start the Run. After completion inspect the Runtime report, `operationCandidates`, and `operationCandidateIssues`; proactively tell the user when an OperationPlan candidate needs approval. Never create Task files manually or write a report by hand.
