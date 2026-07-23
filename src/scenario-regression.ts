import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { taskSourceRunDirectory } from './project.ts';
import { now, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type { ScenarioRegressionDraft, TestRun, TestScenario, TestTask } from './types.ts';

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safePart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'scenario';
}

function sourceSteps(run: TestRun, scenarioId: string): TestRun['steps'] {
  return run.steps.filter(step => step.source === 'ui' && step.scenarioId === scenarioId && step.humanApproval && step.humanVerdict);
}

function flowHash(task: TestTask, run: TestRun, scenario: TestScenario, steps: TestRun['steps']): string {
  return hashText(JSON.stringify({
    taskId: task.metadata.id,
    runId: run.id,
    planHash: run.planHash,
    scenarioId: scenario.id,
    plannedSteps: scenario.plannedSteps,
    steps: steps.map(step => ({
      id: step.id,
      plannedStepId: step.plannedStepId,
      action: step.action,
      uiAction: step.uiAction,
      locator: step.actualLocator ?? step.locator,
      inputRefs: step.inputRefs ?? {},
      expectedState: step.expectedState,
      verdict: step.humanVerdict?.status,
    })),
    assertions: (scenario.visualAssertions ?? []).map(assertion => ({ id: assertion.id, expected: assertion.expected })),
    cleanup: scenario.cleanup,
  }));
}

function renderScript(input: { scriptId: string; run: TestRun; scenario: TestScenario; steps: TestRun['steps']; sourceFlowHash: string }): string {
  const metadata = JSON.stringify({
    scriptId: input.scriptId,
    sourceRunId: input.run.id,
    sourceStepIds: input.steps.map(step => step.id),
    sourceFlowHash: input.sourceFlowHash,
  });
  const steps = input.steps.map(step => ({
    id: step.id,
    plannedStepId: step.plannedStepId,
    action: step.uiAction ?? 'assert',
    description: step.action,
    locator: step.actualLocator ?? step.locator ?? null,
    inputRefs: step.inputRefs ?? {},
    expected: step.expectedState ?? '',
  }));
  return `# QA_AGENT_REGRESSION: ${metadata}
"""Generated from a user-led QA scenario. Review the bridge contract before publication."""

import json
import os
import subprocess
from pathlib import Path

STEPS = ${JSON.stringify(steps, null, 2)}
SCENARIO_ID = ${JSON.stringify(input.scenario.id)}
RESULT_API_VERSION = "qa-agent/python-regression-result/v1"


def execute_step(bridge: str, step: dict, screenshot_dir: Path) -> dict:
    screenshot = screenshot_dir / f"{step['id']}.png"
    payload = json.dumps({"scenarioId": SCENARIO_ID, "step": step, "screenshot": str(screenshot)})
    completed = subprocess.run([bridge, payload], capture_output=True, text=True, check=False)
    actual = completed.stdout.strip() or completed.stderr.strip() or f"bridge exit code {completed.returncode}"
    status = "passed" if completed.returncode == 0 and screenshot.exists() else "blocked"
    return {
        "id": step["id"],
        "name": step["description"],
        "status": status,
        "expected": step.get("expected", ""),
        "actual": actual,
        "screenshot": str(screenshot),
    }


def main() -> None:
    result_path = Path(os.environ["QA_AGENT_RESULT_PATH"])
    screenshot_dir = Path(os.environ["QA_AGENT_SCREENSHOT_DIR"])
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    bridge = os.environ.get("QA_AGENT_BRIDGE")
    if not bridge:
        results = [{
            "id": step["id"],
            "name": step["description"],
            "status": "blocked",
            "expected": step.get("expected", ""),
            "actual": "QA_AGENT_BRIDGE is not configured.",
            "screenshot": str(screenshot_dir / f"{step['id']}.png"),
        } for step in STEPS]
    else:
        results = [execute_step(bridge, step, screenshot_dir) for step in STEPS]
    status = "passed" if results and all(step["status"] == "passed" for step in results) else "blocked"
    result = {
        "apiVersion": RESULT_API_VERSION,
        "status": status,
        "contractStatus": "completed" if status == "passed" else "blocked",
        "conclusion": f"Scenario {SCENARIO_ID}: {status}",
        "steps": results,
        "cleanup": [],
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
`;
}

export function generateGuidedScenarioRegressions(root: string, task: TestTask, run: TestRun): ScenarioRegressionDraft[] {
  if (task.metadata.mode !== 'guided') return [];
  const scenarios = task.scenarios.filter(scenario => !run.scenarioId || scenario.id === run.scenarioId);
  const runDirectory = taskSourceRunDirectory(root, run.moduleId, run.taskId);
  const generatedAt = now();
  const drafts = scenarios.map(scenario => {
    const steps = sourceSteps(run, scenario.id);
    if (!steps.length) throw new Error(`User-led Scenario ${scenario.id} has no human-approved and human-confirmed UI steps.`);
    const scriptId = `${safePart(task.metadata.id)}-${safePart(scenario.id)}`.slice(0, 63);
    const sourceFlowHash = flowHash(task, run, scenario, steps);
    const script = renderScript({ scriptId, run, scenario, steps, sourceFlowHash });
    const directory = join(runDirectory, 'scenario-regressions', safePart(scenario.id));
    mkdirSync(directory, { recursive: true });
    const scriptPath = join(directory, 'script.py');
    const manifestPath = join(directory, 'manifest.json');
    const draft: ScenarioRegressionDraft = {
      scenarioId: scenario.id,
      scriptId,
      scriptRef: `scenario-regressions/${safePart(scenario.id)}/script.py`,
      manifestRef: `scenario-regressions/${safePart(scenario.id)}/manifest.json`,
      sourceStepIds: steps.map(step => step.id),
      sourceFlowHash,
      scriptHash: hashText(script),
      generatedAt,
    };
    writeTextAtomic(scriptPath, script);
    writeJsonAtomic(manifestPath, { apiVersion: 'qa-agent/scenario-regression-draft/v1', kind: 'ScenarioRegressionDraft', runId: run.id, ...draft });
    return draft;
  });
  run.scenarioRegressionDrafts = drafts;
  for (const draft of drafts) run.evidence.push({ type: 'scenario-regression-draft', path: draft.scriptRef, summary: `Generated user-led regression draft for Scenario ${draft.scenarioId}.` });
  return drafts;
}
