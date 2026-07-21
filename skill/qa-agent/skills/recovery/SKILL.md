---
name: qa-agent-recovery
description: Safely resume blocked, paused, interrupted, or stale QA workflows without bypassing Runtime gates.
---

# Recovery

Follow only Runtime-provided recovery `nextActions`. Preserve the current Task, Run, evidence, event history, and resumeToken. Use approved recovery actions such as wait, refresh/back, restart app, reset sandbox data, reconnect MCP, fallback locator, or resume checkpoint.

Do not bypass approval, capability, permission, safety, environment, planHash, contextHash, or stale OperationPlan gates. If business meaning changed, return to planning and obtain a new TestPlan approval.
