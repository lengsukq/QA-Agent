# Recommended Regression Stack

This document is the single source of truth for QA Agent's built-in regression Runner prerequisites.

The UI execution stack is fixed. The stack is recommended as a setup guide, not a project policy; selected-platform prerequisites are execution gates. Agents may record reviewed JSON steps, but formal replay must use `qa-agent regression run` and the packaged `qa_agent_runner`.

## Web external testing

Recommended stack:

```text
Python 3.12+
+ pytest
+ pytest-playwright
+ Playwright browser runtime
```

Recommended setup:

```bash
python3 -m venv .qa-agent/venv
.qa-agent/venv/bin/pip install pytest pytest-playwright
.qa-agent/venv/bin/playwright install chromium
```

Use Playwright for browser lifecycle, stable locators, UI actions, assertions, and screenshots. Use pytest for fixtures, parameterization, assertions, cleanup, and execution control.

Official references:

- <https://playwright.dev/python/docs/intro>
- <https://playwright.dev/python/docs/test-runners>
- <https://playwright.dev/python/docs/browsers>

## iOS Simulator testing

Recommended stack:

```text
Python 3.12+
+ pytest
+ xcrun simctl
+ fb-idb CLI
+ idb_companion
```

Recommended responsibilities:

```text
xcrun simctl
→ simulator lifecycle, app install/launch, permissions, and screenshots

fb-idb + idb_companion
→ simulator UI queries, input, and app control

pytest
→ fixtures, parameterization, assertions, cleanup, and execution control
```

Recommended setup:

```bash
python3 -m venv .qa-agent/venv
.qa-agent/venv/bin/pip install pytest fb-idb
brew tap facebook/fb
brew install idb-companion
```

A full Xcode installation is required for the recommended idb companion workflow. The Xcode Command Line Tools alone are not sufficient for that adapter.

Official reference:

- <https://fbidb.io/docs/installation/>

## Formal output contract

The official regression assets remain inside the corresponding Task:

```text
.qa-agent/modules/<module>/tasks/<task>/regression-runs/<run-id>/
├── run.json
├── result.json
├── report.md
├── stdout.log
├── stderr.log
├── screenshots/
└── evidence/
```

Required outputs:

- `result.json`: structured business and execution-contract result;
- `report.md`: Runtime-generated human-readable report;
- `screenshots/`: screenshots referenced by the result;
- `stdout.log` and `stderr.log`: captured process output.

`evidence/` is optional. Use it only for a small number of diagnostic files that materially help explain a failure, such as a browser console error or an idb command error. Do not create extra formal artifact categories.

## Execution environment rules

When preparing the regression Runner environment:

1. Read the source Run and this recommendation.
2. Use the packaged Runner adapters: Playwright for Web; `xcrun simctl` plus `idb` for iOS Simulator.
3. Do not introduce MCP, ADB, another browser/device driver, or a competing executor.
4. Provide required packages, commands, environment variables, and adapter requirements alongside the regression steps.
5. Write all formal execution outputs to the Runtime-provided Task Run directories.

## Doctor behavior

`qa-agent doctor` reports the recommended stack for the project's configured Web and iOS platforms.

Runner prerequisites are execution gates:

```text
available
missing
incompatible
unknown
```

Missing Python/Playwright blocks Web. Missing Python/`xcrun simctl`/`idb`/a booted Simulator blocks iOS. Run `qa-agent doctor --platforms <web|ios>` for the next repair command.

## Virtual environment

- Location is fixed at `.qa-agent/venv/`.
- Runtime Python resolution priority: `QA_AGENT_PYTHON` env > `.qa-agent/venv/bin/python` > `python3`.
- All pip packages (playwright, fb-idb, pytest, etc.) are installed inside the venv.
- No manual `source activate` is needed; Runtime references the binary path directly.
