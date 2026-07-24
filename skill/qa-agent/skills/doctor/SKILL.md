---
name: qa-agent-doctor
description: Guide first-run QA Agent environment setup and readiness checks. Use when a project is not initialized, the Agent host is not configured, `qa-agent doctor` reports missing or unknown Runner, Python, browser, simulator, device, or capability state, or before the first real QA check.
---

# QA Agent Doctor

Use this Skill to prepare the project and Agent host before ordinary QA or formal JSON replay. It diagnoses readiness, explains blocking versus advisory findings, gives the next explicit repair command, and reruns the check after the user applies a change.

## First-run workflow

1. Locate the project root. If `.qa-agent/project.json` is missing, explain that planning and execution are not ready and guide the user to run `qa-agent init` with the intended `--platforms` and host flag. Configure a host with `qa-agent configure --project <project> --host <host>` when initialization did not install one.
2. Run `qa-agent doctor --platforms <platforms>` and inspect the JSON fields `runner`, `availableCapabilities`, `notes`, and `recommendedRegressionStack`.
3. Confirm the managed Runner exists at `.qa-agent/runner/qa_agent_runner`. This is the packaged executor copied during `init` or `update`; do not replace it with a project-local implementation.
4. Classify findings:
   - Blocking for UI execution: missing required Host capabilities, unverified or missing macOS permissions, missing managed Runner, or missing platform tools required by the selected approved adapter.
   - Advisory: missing recommended Python, Playwright, iOS, or browser tools when another approved adapter can produce the Runtime result contract.
   - Planning-only: missing execution tools may be reported while the Agent continues source inspection and PRD planning.
5. Give one concrete next step at a time. Use the install hints and setup commands returned by Doctor, but do not install Python packages, browsers, idb, MCPs, or system permissions automatically. Ask the user to apply the step when it changes external state.
6. Rerun `qa-agent doctor` after each repair. Do not declare the environment ready from a single installed-tool check; verify the Runner, required capabilities, permission state, and selected platform readiness together.
7. When required checks pass, hand off to the main `qa-agent` Skill for Task planning. Load `qa-agent-regression-test` only when the user has approved JSON steps to replay.

## Replay boundary

Agents record reviewed JSON steps and call `qa-agent regression run <script-id> --module <module> --task <task>`. The Runtime starts the unified Python executor from `.qa-agent/runner`; do not call a copied script, create a second executor, or use direct UI tools to bypass the readiness and evidence contract.

Never claim readiness, fabricate capability snapshots, or silently treat a missing required capability as an advisory recommendation.
