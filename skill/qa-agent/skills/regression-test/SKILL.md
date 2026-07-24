---
name: qa-agent-regression-test
description: Run previously approved regression steps and present the Runtime-generated regression report.
---

# Regression Test

Use this Skill only when the Task already contains approved regression steps.

Do not create, edit, approve, or publish steps. Do not rediscover the business flow, change step order, or replace the formal steps' declared adapter with another recommended stack during execution.

## Run

1. Resolve the Task and formal steps. Use `qa-agent regression list --module <module> --task <task>` when needed.
2. Run:

```bash
qa-agent regression run <script-id> --module <module> --task <task>
```

3. Let the steps file control the fixed sequence.
4. Inspect every screenshot-backed checkpoint together with its expected and actual state. Do not decide the business result from `result.json` alone.
5. Verify that every source step has a real, non-empty screenshot under `screenshots/`. Missing, empty, unknown-step, or out-of-directory screenshots make the execution contract invalid.
6. Present the Runtime-generated regression report only after confirming its checkpoint screenshots support the stated outcome. A formal report must embed every checkpoint screenshot with Markdown image syntax; screenshot paths alone are invalid. Include the returned clickable report or diagnostic `userFacingArtifacts[].markdownLink` in the same reply; never provide only a plain path. Explain the business result from the screenshots, structured result, stdout, stderr, and Cleanup without writing a competing formal report.

A genuine product failure may still have `contractStatus=completed`; preserve the business FAIL while treating the steps contract as valid.
