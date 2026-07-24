---
name: qa-agent-guided
description: Run QA-led, step-by-step testing where every UI action and observed result requires an explicit human QA decision.
---

# Guided QA

Use this Skill when a human QA wants to direct the test one step at a time, explore a new feature, confirm uncertain expectations, or turn a manually reviewed flow into a reusable Case.

Read `references/workflow.md` from the main `qa-agent` Skill before acting. Runtime owns the shared Task/Run/Step core, evidence, safety, reports, and Scenario regression drafts. User-led control keeps only one pending interaction; completed approvals and verdicts live on their Step.

Guided UI execution is limited to Web and iOS Simulator through `qa-agent act` and the built-in Runner. Never call MCP, Playwright, xcrun, idb, ADB, or another UI tool directly. If the selected platform is wrong, stop and run `qa-agent doctor --platforms <web|ios>` before reapplying the PlanDraft.

## Prepare the Case

1. Create or resume it with `qa-agent check --mode guided --request "<request>"`.
2. Inspect relevant source, routes, configuration, tests, existing QA assets, and available tools.
3. Generate a complete PlanDraft and apply it with `qa-agent plan apply`.
4. Present the complete Runtime-written Task PRD and include its clickable `userFacingArtifacts[].markdownLink` in the same reply. Do not show only a plain path.
5. Inspect source, configuration, entry points, installed targets, and capabilities to determine exactly one platform after the plan is generated. Persist `web` or `ios` in `PlanDraft.platformDeclaration.platform` with `declaredBy: "qa-agent"`, keep the matching single `scope.platforms` entry, and apply the updated PlanDraft again. Ask the QA only when the platform is ambiguous.
6. If the PRD contains `userQuestions`, ask the QA one concrete question at a time. Add answers to `confirmedDecisions`, clear resolved questions, and apply the updated PlanDraft again.
7. Set `PlanDraft.executionIntent` to `state-changing` for Guided Tasks. Ask whether the PRD matches the requested behavior. Only the exact reply `确认测试方案` may be persisted through `qa-agent plan review`.
8. Separately wait for the exact reply `确认开始测试`, persist it through `qa-agent review`, and only then call `qa-agent test`.

Plan confirmation and start authorization are separate decisions. Never infer either from “可以”, “继续”, “是的”, or similar text unless it is the direct answer to the single Guided action/result question currently being asked and is persisted through the corresponding Guided command.

## Run one step at a time

For every UI operation:

1. Describe exactly one proposed action and its expected result. Ask the QA whether to proceed.
2. After the QA approves, persist that decision with `qa-agent run guide-approve`, using the matching PRD `--planned-step` when available. Do not use a UI tool before Runtime returns `uiExecutionAllowed=true`.
3. Execute only that approved action. Persist it with `qa-agent run step`, including the real screenshot, actual locator, expected state, and actual state.
4. Present the observed result and ask whether it matches expectations.
5. Persist the QA verdict with `qa-agent run guide-verdict`. Until that verdict is recorded, do not execute another UI action or complete the Run.

A QA-directed action added during execution may be approved with explicit `--action` and `--expected`. It must not silently replace an existing PRD expectation.

If the QA says the result is wrong, record `failed`, preserve the screenshot and actual state, then ask whether to continue, retry, add another step, or stop. Never rewrite the expected result to make the step pass.

## Save the Case

When the QA asks to save the Case:

- ensure every UI step has both a human approval and a human verdict;
- record all declared assertions and Cleanup;
- complete through `qa-agent run complete` in the same turn—never defer it to a later conversation;
- Runtime automatically generates one independent regression-steps draft (steps.json) for every selected Scenario under `source-run/scenario-regressions/<scenario-id>/`;
- present the Runtime report, saved PRD, and every Scenario steps file through their clickable `userFacingArtifacts[].markdownLink`; the formal report must embed its real screenshots with Markdown image syntax rather than listing screenshot paths only;
- do not ask the generic post-test regression-generation question in user-led mode, because the Scenario steps drafts already exist;
- treat generated Scenario steps as drafts. Formal publication or execution still requires separate review and approval.
