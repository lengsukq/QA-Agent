import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { taskDirectory } from './project.ts';
import { writeJsonAtomic, readJson } from './store.ts';
import type { TestRun } from './types.ts';

export const REGRESSION_STEPS_API_VERSION = 'qa-agent/regression-steps/v1';

export interface RegressionStepEntry {
  id: string;
  cmd: string;
  params: Record<string, unknown>;
}

export interface RegressionStepsFile {
  apiVersion: typeof REGRESSION_STEPS_API_VERSION;
  id: string;
  platform: 'web' | 'ios';
  sourceRunId: string;
  sourcePlanHash?: string;
  steps: RegressionStepEntry[];
  cleanup: RegressionStepEntry[];
}

/** Map uiAction values to driver command names */
const UI_ACTION_TO_CMD: Record<string, string> = {
  navigate: 'navigate',
  click: 'click',
  fill: 'fill',
  input: 'fill',
  swipe: 'swipe',
  launch: 'launch',
  wait: 'wait',
  assert: 'assert_visible',
  screenshot: 'screenshot',
  back: 'back',
  reset: 'navigate',
  'restart-app': 'launch',
};

/**
 * Map a single source Run step to a regression step entry (cmd + params).
 */
export function stepToRegressionEntry(step: TestRun['steps'][number]): RegressionStepEntry {
  const cmd = UI_ACTION_TO_CMD[step.uiAction ?? ''] ?? step.uiAction ?? 'assert_visible';
  return { id: step.id, cmd, params: buildStepParams(step, cmd) };
}

/**
 * Map an array of already-filtered source steps to regression step entries.
 */
export function stepsFromSourceSteps(steps: TestRun['steps']): RegressionStepEntry[] {
  return steps.map(stepToRegressionEntry);
}

/**
 * Export regression steps from a completed Run.
 * Only UI-source steps with passed status are included.
 *
 * When `sourceStepIds` is provided, the export is restricted to exactly those
 * step ids (preserving Run order) so the resulting file matches the validated
 * source flow precisely.
 */
export function exportStepsFromRun(root: string, run: TestRun, id?: string, sourceStepIds?: string[]): RegressionStepsFile {
  const platform = (run.context?.platform ?? 'web') as 'web' | 'ios';
  const steps: RegressionStepEntry[] = [];
  const cleanup: RegressionStepEntry[] = [];

  const allowedIds = sourceStepIds ? new Set(sourceStepIds) : undefined;
  for (const step of run.steps) {
    if (allowedIds) {
      if (!allowedIds.has(step.id)) continue;
      steps.push(stepToRegressionEntry(step));
      continue;
    }
    // Only include UI steps that passed and have a uiAction
    if (step.source === 'internal' || step.source === 'recovery') continue;
    if (!['passed', 'adapted'].includes(step.status)) continue;
    if (!step.uiAction) continue;
    steps.push(stepToRegressionEntry(step));
  }

  // Extract cleanup steps from cleanupFindings
  for (let i = 0; i < (run.cleanupFindings ?? []).length; i++) {
    const finding = run.cleanupFindings![i];
    if (finding.status === 'passed') {
      cleanup.push({
        id: `cleanup-${i + 1}`,
        cmd: 'click', // Default cleanup action
        params: { detail: finding.cleanup },
      });
    }
  }

  const stepsFile: RegressionStepsFile = {
    apiVersion: REGRESSION_STEPS_API_VERSION,
    id: id ?? `${run.taskId}-regression`,
    platform,
    sourceRunId: run.id,
    sourcePlanHash: run.planHash,
    steps,
    cleanup,
  };

  return stepsFile;
}

function buildStepParams(step: TestRun['steps'][number], cmd: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (step.locator) params.locator = step.locator;
  if (step.inputRefs) {
    const firstRef = Object.values(step.inputRefs)[0];
    if (firstRef) params.inputRef = firstRef;
  }
  if (step.expectedState && cmd.startsWith('assert')) params.expected = step.expectedState;

  // For navigate, extract URL from detail
  if (cmd === 'navigate' && step.detail) {
    const urlMatch = step.detail.match(/https?:\/\/[^\s]+/);
    if (urlMatch) params.url = urlMatch[0];
  }

  // For launch, extract bundleId from detail
  if (cmd === 'launch' && step.detail) {
    const bundleMatch = step.detail.match(/(?:Launch|launch)\s+([\w.]+)/);
    if (bundleMatch) params.bundleId = bundleMatch[1];
  }

  return params;
}

/**
 * Save a steps file to the task's regression directory.
 */
export function saveStepsFile(root: string, run: TestRun, stepsFile: RegressionStepsFile): string {
  const regressionDir = join(taskDirectory(root, run.moduleId, run.taskId), 'regression');
  mkdirSync(regressionDir, { recursive: true });
  const filePath = join(regressionDir, `${stepsFile.id}.steps.json`);
  writeJsonAtomic(filePath, stepsFile);
  return filePath;
}

/**
 * Validate a steps file for correctness.
 */
export function validateStepsFile(filePath: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!existsSync(filePath)) return { valid: false, errors: [`File not found: ${filePath}`] };

  let doc: RegressionStepsFile;
  try {
    doc = readJson<RegressionStepsFile>(filePath);
  } catch (exc) {
    return { valid: false, errors: [`Invalid JSON: ${(exc as Error).message}`] };
  }

  if (doc.apiVersion !== REGRESSION_STEPS_API_VERSION) {
    errors.push(`apiVersion must be '${REGRESSION_STEPS_API_VERSION}', got '${doc.apiVersion}'`);
  }
  if (!doc.id) errors.push('Missing required field: id');
  if (!doc.platform || !['web', 'ios'].includes(doc.platform)) errors.push(`Invalid platform: '${doc.platform}'`);
  if (!doc.steps?.length) errors.push('Steps array is empty');

  for (let i = 0; i < (doc.steps ?? []).length; i++) {
    const step = doc.steps[i];
    if (!step.cmd) errors.push(`Step ${i}: missing 'cmd' field`);
    if (!step.id) errors.push(`Step ${i}: missing 'id' field`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * List all regression steps files for a task.
 */
export function listStepsFiles(root: string, moduleId: string, taskId: string): string[] {
  const regressionDir = join(taskDirectory(root, moduleId, taskId), 'regression');
  if (!existsSync(regressionDir)) return [];
  return readdirSync(regressionDir)
    .filter(f => f.endsWith('.steps.json'))
    .map(f => join(regressionDir, f));
}
