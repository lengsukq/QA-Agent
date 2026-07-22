---
name: qa-agent-regression-test
description: Run previously approved Python regression scripts and present the Runtime-generated regression report.
---

# Regression Test

Use this Skill only when the Task already contains an approved Python script.

Do not create, edit, approve, or publish scripts. Do not rediscover the business flow or change step order.

## Run

1. Resolve the Task and formal script. Use `qa-agent regression list --module <module> --task <task>` when needed.
2. Run:

```bash
qa-agent regression run <script-id> --module <module> --task <task> [--bridge <command>]
```

3. Let the Python file control the fixed sequence.
4. Inspect the Runtime-generated regression report, structured result, screenshots, stdout, stderr, and Cleanup.
5. Explain the business outcome without writing a competing formal report.

A genuine product failure may still have `contractStatus=completed`; preserve the business FAIL while treating the script contract as valid.
