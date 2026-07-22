# Python Regression Contract

Use this contract only after the Task's real Source Run has completed and `pythonRegressionEligibility.eligible=true`.

Skill ownership:

- main `qa-agent`: asks whether to generate, writes the draft, presents it for review, and publishes after separate approval;
- `qa-agent-regression-test`: runs an already published script and reviews the Runtime-generated report.

## Recommended platform stack

Before generating a draft, read `references/recommended-regression-stack.md`.

Default recommendation when the project has no established regression framework:

```text
Web
→ Python 3.12+ + pytest + pytest-playwright + Playwright

iOS Simulator
→ Python 3.12+ + pytest + xcrun simctl + fb-idb + idb_companion

Agent-assisted iOS exploration
→ ios-simulator-mcp
```

This recommendation is not a mandatory Runtime dependency. Reuse an existing project framework when it already supports direct command-line execution, the QA Agent result contract, screenshots, Cleanup, and Runtime reporting. Initial evidence stays under `source-run/`; formal rerun outputs stay under `regression-runs/`.

## Approval boundaries

Generation approval and publication approval are separate decisions.

```text
approve draft generation
≠
approve reviewed script publication
```

Runtime never authors Python code. The Agent writes code from the exact completed Run. Runtime validates, stores, publishes, executes, and reports it.

## Source contract

The source Run must provide:

- `passed` or `adapted` completed status;
- Runtime-owned report;
- host-automated UI steps;
- stable locators for interactive actions;
- structured `inputRefs` instead of raw secrets;
- screenshot evidence for every source UI step;
- screenshot-backed business assertions;
- completed declared Cleanup.

Runtime computes `sourceFlowHash` directly from the recorded steps, locators, input references, assertions, screenshots, and Cleanup.

The Python file must contain near the top:

```python
# QA_AGENT_REGRESSION: {"scriptId":"login-flow","sourceRunId":"run-...","sourceStepIds":["agent-2"],"sourceFlowHash":"sha256..."}
```

It must write a structured result to `QA_AGENT_RESULT_PATH` using `qa-agent/python-regression-result/v1`.

## Draft and publication

Create a draft:

```bash
qa-agent regression draft --module MODULE --task TASK --run RUN_ID --file SCRIPT.py --id SCRIPT_ID
```

Show the complete script or complete diff. After explicit review approval, publish:

```bash
qa-agent regression publish --module MODULE --task TASK --draft SCRIPT_ID --confirmed-by HUMAN
```

A draft is not a formal Task asset. Publication places the `.py` file and its manifest under `regression/` and freezes the current Source Run. Later execution must use the published script; do not start another initial Source Run unless the TestPlan changes and the old script becomes `stale`.

## Execution

Run a formal script:

```bash
qa-agent regression run SCRIPT_ID --module MODULE --task TASK [--bridge COMMAND]
```

The script controls the fixed business sequence. Do not rediscover or rewrite the flow during regression. Runtime stores the result, report, screenshots, stdout, stderr, and Cleanup under `regression-runs/`.

A business FAIL with `contractStatus=completed` means the script is valid and the product behavior failed. Do not rewrite the script automatically.
