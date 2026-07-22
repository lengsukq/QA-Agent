# Recommended Regression Stack

This document is the single source of truth for QA Agent's recommended Python regression environment.

The stack is **recommended, not mandatory**. A project may use another approved framework or Host Bridge as long as the formal Python script writes the QA Agent result contract and preserves required evidence.

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

Use Playwright for:

- browser lifecycle and isolation;
- role, label, text, test-id, and CSS locators;
- screenshots and videos;
- DOM or page-state snapshots;
- console and network evidence;
- Playwright Trace.

Suggested pytest execution:

```bash
python3.12 -m pytest qa-regression/web \
  --junitxml=artifacts/junit.xml \
  --tracing=retain-on-failure \
  --screenshot=only-on-failure
```

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
→ simulator lifecycle, app install/launch, permissions, screenshots, and video

fb-idb + idb_companion
→ simulator UI queries, input, app control, and accessibility-oriented automation

pytest
→ fixtures, parameterization, assertions, cleanup, JUnit XML, and execution control
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

Use it for the first Agent-guided business run:

- inspect available simulators;
- launch and explore the app;
- capture screenshots;
- inspect UI hierarchy or targeted elements;
- verify the business flow before generating Python.

Do not make it the only dependency of a formal regression script. The reviewed Python file should remain directly runnable from the command line through the selected adapter.

Project reference:

- <https://github.com/joshuayoes/ios-simulator-mcp>

## Unified output contract

Recommended run output:

```text
artifacts/<run-id>/
├── result.json
├── report.md
├── junit.xml
├── allure-results/
├── screenshots/
├── ui-tree/
├── traces/
├── logs/
├── videos/
└── raw/
```

Platform-specific evidence may differ:

### Web

```text
screenshots/
ui-tree/dom-snapshot.html
traces/playwright-trace.zip
logs/console.log
logs/network.json
videos/
```

### iOS Simulator

```text
screenshots/
ui-tree/accessibility-tree.json
logs/simctl.log
logs/idb.log
videos/simulator.mp4
raw/
```

Do not require iOS to produce a Playwright-compatible Trace. The formal result may reference an iOS command log, accessibility tree, video, or other platform-native evidence instead.

## Reporting

The formal script must always write:

```text
result.json
```

using the QA Agent Python result contract.

Recommended additional outputs:

- `report.md`: Runtime-generated human-readable summary;
- `junit.xml`: CI and test-platform integration;
- `allure-results/`: optional rich report data and attachments;
- screenshots and UI Tree: evidence tied to test steps;
- Trace or platform execution logs: debugging evidence.

Optional Allure integration:

```bash
python3.12 -m pip install allure-pytest
python3.12 -m pytest --alluredir allure-results
```

Official reference:

- <https://allurereport.org/docs/pytest/>

## Agent generation rules

When generating a Python regression draft:

1. Read the source Run and this recommendation.
2. Prefer pytest plus the platform adapter listed above when the project has no established framework.
3. Reuse an existing project framework when it already satisfies the result and evidence contracts.
4. Do not introduce an unapproved dependency silently.
5. Show required packages, commands, environment variables, and Host Bridge requirements with the draft.
6. Preserve direct command-line execution.
7. Keep Allure optional; `result.json`, screenshots, and Runtime reporting remain authoritative.

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
