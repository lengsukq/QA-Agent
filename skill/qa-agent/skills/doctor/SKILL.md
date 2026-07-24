---
name: qa-agent-doctor
description: Guide first-run QA Agent environment setup and readiness checks. Use when a project is not initialized, the Agent host is not configured, `qa-agent doctor` reports missing or unknown Runner, Python, browser, simulator, device, or capability state, or before the first real QA check.
---

# QA Agent Doctor

Use this Skill to prepare the project and Agent host before ordinary QA or formal JSON replay. It diagnoses readiness, explains blocking versus advisory findings, gives the next explicit repair command, and reruns the check after the user applies a change.

## First-run workflow

1. Locate the project root. If `.qa-agent/project.json` is missing, explain that planning and execution are not ready and guide the user to run `qa-agent init --platforms web` or `qa-agent init --platforms ios` with the intended host flag. Configure a host with `qa-agent configure --project <project> --host <host>` when initialization did not install one.
2. Run `qa-agent doctor --platforms <platforms>` and inspect the JSON fields `runner`, `availableCapabilities`, `notes`, and `recommendedRegressionStack`.
3. Confirm the unified Runner resolves from `QA_AGENT_RUNNER_DIR`, the npm package, or an existing project Runner. `qa-agent init` does not copy a Runner into the project. Do not replace the resolved Runner with a project-local implementation.
4. Classify findings:
   - Blocking for UI execution: unsupported platform, missing unified Runner, missing Python or Playwright, missing `xcrun simctl`, missing `idb`, no booted iOS Simulator, or missing required local permission.
   - Recommended but non-blocking: optional evidence/reporting conveniences. These must never introduce another UI execution tool.
   - Planning-only: a missing execution prerequisite may be reported while the Agent continues source inspection and PRD planning, but `qa-agent test` remains blocked until the selected adapter is ready.
5. If the project does not yet have `.qa-agent/venv/`, guide the user to create a virtual environment:
   ```bash
   python3 -m venv .qa-agent/venv
   .qa-agent/venv/bin/pip install playwright fb-idb
   .qa-agent/venv/bin/playwright install chromium
   ```
   All subsequent Python dependencies are installed into this venv without polluting the system environment. Doctor automatically uses `.qa-agent/venv/bin/python` when it exists.
6. Give one concrete next step at a time. Use the install hints and setup commands returned by Doctor, but do not install Python packages, browsers, idb, third-party tools, or system permissions automatically. Ask the user to apply the step when it changes external state.
7. Rerun `qa-agent doctor` after each repair. Do not declare the environment ready from a single installed-tool check; verify the Runner, required capabilities, permission state, and selected platform readiness together.
8. If a Task is configured for Web but source evidence shows iOS, stop the current execution path, run `qa-agent doctor --platforms ios`, reapply the Agent-inferred iOS PlanDraft, and return to the main `qa-agent` Skill for the confirmation mode required by the current Task. Never call iOS MCP or direct simulator tools to bridge the mismatch.
9. When required checks pass, hand off to the main `qa-agent` Skill for Task planning. After the detailed TestPlan is generated, the Agent determines Web or iOS from source/configuration and writes `PlanDraft.platformDeclaration`; ask the QA only when the platform is ambiguous. Load `qa-agent-regression-test` only when the user has approved JSON steps to replay.

## Replay boundary

Agents record reviewed JSON steps and call `qa-agent regression run <script-id> --module <module> --task <task>`. The Runtime starts `python3 -m qa_agent_runner replay` using the same resolved unified Runner as Driver and Doctor; do not call a copied script, create a second executor, or use direct UI tools to bypass the readiness and evidence contract.

Never claim readiness, fabricate capability snapshots, or silently treat a missing required capability as an advisory recommendation.
