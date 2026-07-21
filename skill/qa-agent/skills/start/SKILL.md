---
name: qa-agent-start
description: Discover project context and create or resume a QA Task without executing the UI.
---

# Start and Discovery

1. Read the active project, Module, existing Task, reviewed memory, relevant source/tests/configuration, historical Runs, and OperationPlans before asking the user.
2. Run `qa-agent start --request "..." --module <module> --task <task>` to create or resume the complete Task package.
3. Record confirmed facts, assumptions, risks, scope, roles, environments, test data, cleanup, Scenario coverage, and source references in Runtime-owned assets.
4. Ask at most one user-owned decision per turn. Include why it matters, the recommended answer, and the effect of alternatives.
5. Stop before UI execution. Continue to Review when the Runtime returns an approval gate.
