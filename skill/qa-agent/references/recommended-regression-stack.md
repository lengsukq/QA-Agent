# Recommended Regression Stack

This document is the single source of truth for QA Agent's recommended Python regression environment.

The stack is **recommended, not mandatory**. A project may use another approved framework or Host Bridge as long as the formal Python script is directly runnable, writes the QA Agent result contract, captures required screenshots, and preserves only useful evidence.

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
python3.12 -m pip install pytest pytest-playwright
python3.12 -m playwright install chromium
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
python3.12 -m pip install pytest fb-idb
brew tap facebook/fb
brew install idb-companion
```

A full Xcode installation is required for the recommended idb companion workflow. The Xcode Command Line Tools alone are not sufficient for that adapter.

Official reference:

- <https://fbidb.io/docs/installation/>

## Agent-assisted iOS exploration

Recommended optional exploration tool:

```text
ios-simulator-mcp
```

Use it to inspect available simulators, launch and explore the app, capture screenshots, and verify the business flow before generating Python.

Do not make it the only dependency of a formal regression script. The reviewed Python file should remain directly runnable from the command line through the selected adapter.

Project reference:

- <https://github.com/joshuayoes/ios-simulator-mcp>

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

## Agent generation rules

When generating a Python regression draft:

1. Read the source Run and this recommendation.
2. Prefer pytest plus the platform adapter listed above when the project has no established framework.
3. Reuse an existing project framework when it already satisfies direct command-line execution, `result.json`, screenshots, cleanup, and Runtime reporting.
4. Do not introduce an unapproved dependency silently.
5. Show required packages, commands, environment variables, and Host Bridge requirements with the draft.
6. Write all formal execution outputs to the Runtime-provided Task Run directories.
7. Do not add unrelated reporting or diagnostic frameworks by default.

## Doctor behavior

`qa-agent doctor` reports the recommended stack for the project's configured Web and iOS platforms.

Tool states are advisory:

```text
available
missing
incompatible
unknown
```

Missing recommended or optional tools must not block QA Agent when another approved execution adapter and the result contract are available.
