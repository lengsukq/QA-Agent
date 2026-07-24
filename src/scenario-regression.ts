import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { taskSourceRunDirectory } from './project.ts';
import { REGRESSION_STEPS_API_VERSION, stepsFromSourceSteps, type RegressionStepsFile } from './regression-steps.ts';
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

function buildScenarioStepsFile(input: { scriptId: string; run: TestRun; scenario: TestScenario; steps: TestRun['steps'] }): RegressionStepsFile {
  const platform = (input.run.context?.platform ?? 'web') as 'web' | 'ios';
  const cleanup = (input.run.cleanupFindings ?? [])
    .filter(finding => finding.scenarioId === input.scenario.id && finding.status === 'passed')
    .map((finding, index) => ({ id: `cleanup-${index + 1}`, cmd: 'click', params: { detail: finding.cleanup } }));
  return {
    apiVersion: REGRESSION_STEPS_API_VERSION,
    id: input.scriptId,
    platform,
    sourceRunId: input.run.id,
    sourcePlanHash: input.run.planHash,
    steps: stepsFromSourceSteps(input.steps),
    cleanup,
  };
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
    const stepsFile = buildScenarioStepsFile({ scriptId, run, scenario, steps });
    const serialized = `${JSON.stringify(stepsFile, null, 2)}\n`;
    const directory = join(runDirectory, 'scenario-regressions', safePart(scenario.id));
    mkdirSync(directory, { recursive: true });
    const scriptPath = join(directory, 'steps.json');
    const manifestPath = join(directory, 'manifest.json');
    const draft: ScenarioRegressionDraft = {
      scenarioId: scenario.id,
      scriptId,
      scriptRef: `scenario-regressions/${safePart(scenario.id)}/steps.json`,
      manifestRef: `scenario-regressions/${safePart(scenario.id)}/manifest.json`,
      sourceStepIds: steps.map(step => step.id),
      sourceFlowHash,
      scriptHash: hashText(serialized),
      generatedAt,
    };
    writeTextAtomic(scriptPath, serialized);
    writeJsonAtomic(manifestPath, { apiVersion: 'qa-agent/scenario-regression-draft/v1', kind: 'ScenarioRegressionDraft', runId: run.id, ...draft });
    return draft;
  });
  run.scenarioRegressionDrafts = drafts;
  for (const draft of drafts) run.evidence.push({ type: 'scenario-regression-draft', path: draft.scriptRef, summary: `Generated user-led regression steps for Scenario ${draft.scenarioId}.` });
  return drafts;
}
