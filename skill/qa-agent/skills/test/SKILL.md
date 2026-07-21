---
name: qa-agent-test
description: Create, continue, and execute approved QA Tasks through the qa-agent CLI.
---

# QA Agent Test

Use `qa-agent start` to create the complete Task package in one CLI call. Present the returned plan, planHash, Task directory, and TodoList; wait for explicit human approval. Persist approval with `qa-agent task review`, then use `qa-agent test` to start the Run. After a successful exploratory Run, actively call `qa-agent operation generate --module <module> --task <task> --run <run-id>` to write the quick-regression OperationPlan candidate. Ask for approval, approve it through `qa-agent task operation review`, run `qa-agent test` again for a real replay/adapted regression check, and only then allow `qa-agent archive`. Never create Task files manually or write a report by hand.
