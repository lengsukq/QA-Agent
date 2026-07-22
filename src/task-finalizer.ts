import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { testPlanHash } from './approval.ts';
import { rebuildIndexes } from './indexer.ts';
import { qaPath, readRunById, readTask, saveTask, taskDirectory, taskPrdPath, taskSourceRunPath, taskSourceRunReportPath } from './project.ts';
import { now, readJson, withFileLock, writeTextAtomic } from './store.ts';
import type { RunStatus, TaskFinalizationResult, TestRun, TestTask } from './types.ts';
import { normalizeTaskState, transitionTaskState } from './workflow-model.ts';

const PRD_START = '<!-- QA-AGENT:RESULTS:START -->';
const PRD_END = '<!-- QA-AGENT:RESULTS:END -->';

function latestCompletedRun(root: string, task: TestTask): TestRun | undefined {
  const path = taskSourceRunPath(root, task.metadata.moduleId, task.metadata.id);
  if (!existsSync(path)) return undefined;
  const run = readJson<TestRun>(path);
  return run.completedAt && run.moduleId === task.metadata.moduleId && run.taskId === task.metadata.id ? run : undefined;
}

function runRelativeAsset(_run: TestRun, path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized.startsWith('source-run/') ? normalized : `source-run/${normalized}`;
}

function verifiedRunAsset(root: string, task: TestTask, run: TestRun, path: string): string {
  const taskRoot = resolve(taskDirectory(root, task.metadata.moduleId, task.metadata.id));
  const relativePath = runRelativeAsset(run, path);
  const absolute = resolve(taskRoot, relativePath);
  if (absolute !== taskRoot && !absolute.startsWith(`${taskRoot}${sep}`)) throw new Error(`Finalizer asset escapes the Task directory: ${path}.`);
  if (!existsSync(absolute)) throw new Error(`Finalizer asset is missing: ${relativePath}.`);
  return relativePath;
}

function markdownText(value: string): string {
  return value.replaceAll('\r', ' ').replaceAll('\n', ' ').trim();
}

function statusLabel(status: RunStatus): string {
  return status.replaceAll('_', ' ').toUpperCase();
}

function screenshotLines(root: string, task: TestTask, run: TestRun): string[] {
  if (!run.screenshots.length) return ['- No screenshots were recorded for this Run.'];
  return run.screenshots.flatMap((screenshot, index) => {
    const path = verifiedRunAsset(root, task, run, screenshot.path);
    const label = markdownText(screenshot.summary) || `Screenshot ${index + 1}`;
    return [`### Screenshot ${index + 1}`, '', `- ${label}`, `![${label}](./${path})`, ''];
  });
}

function generatedPrdSection(root: string, task: TestTask, run: TestRun): string {
  const failures = run.visualFindings.filter(item => item.status === 'failed');
  const passed = run.visualFindings.filter(item => item.status === 'passed');
  const untested = task.scenarios.filter(scenario => !run.scenarioResults.some(result => result.scenarioId === scenario.id));
  return [
    PRD_START,
    '## User Goal', '',
    ...task.objectives.map(objective => `- ${markdownText(objective)}`), '',
    '## Latest Runtime Result', '',
    `- Result: ${statusLabel(run.status)}`,
    `- Completed: ${run.completedAt ?? 'unknown'}`,
    `- Environment: ${run.context.environment}`,
    `- Platform: ${run.context.platform}`,
    `- Role: ${run.context.role}`,
    `- Conclusion: ${markdownText(run.conclusion ?? 'No conclusion recorded.')}`,
    '- Detailed report: [source-run/report.md](./source-run/report.md)', '',
    '## Verified Scenarios', '',
    ...(run.scenarioResults.length ? run.scenarioResults.map(result => `- ${result.scenarioId}: ${statusLabel(result.status)}${result.detail ? ` — ${markdownText(result.detail)}` : ''}`) : ['- No Scenario result was recorded.']), '',
    '## Passed Checks', '',
    ...(passed.length ? passed.map(item => `- ${item.scenarioId}/${item.assertionId}: ${markdownText(item.actual)}`) : ['- No passed business assertion was recorded.']), '',
    '## Failed or Blocked Checks', '',
    ...(failures.length ? failures.map(item => `- ${item.scenarioId}/${item.assertionId}: expected ${markdownText(item.expected)}; observed ${markdownText(item.actual)}`) : ['- No failed business assertion was recorded.']), '',
    '## Cleanup and Data Restoration', '',
    ...(run.cleanupFindings.length ? run.cleanupFindings.map(item => `- ${item.scenarioId}: ${markdownText(item.cleanup)} — ${statusLabel(item.status)} — ${markdownText(item.actual)}`) : ['- No cleanup action was declared or recorded.']), '',
    '## Not Covered in This Run', '',
    ...(untested.length ? untested.map(scenario => `- ${scenario.title}`) : ['- All currently planned scenarios were represented in the Run result.']), '',
    '## Key Screenshots', '',
    ...screenshotLines(root, task, run),
    PRD_END,
  ].join('\n');
}

function upsertGeneratedPrd(existing: string | undefined, task: TestTask, generated: string): string {
  if (!existing) return `# ${task.metadata.name}\n\n## Manual Notes\n\nAdd durable product or QA notes here. Content outside the QA-Agent markers is preserved.\n\n${generated}\n`;
  const start = existing.indexOf(PRD_START);
  const end = existing.indexOf(PRD_END);
  if (start >= 0 && end > start) return `${existing.slice(0, start)}${generated}${existing.slice(end + PRD_END.length)}`.trimEnd() + '\n';
  return `${existing.trimEnd()}\n\n${generated}\n`;
}

export function clearTaskResultSection(root: string, task: TestTask): void {
  const path = taskPrdPath(root, task.metadata.moduleId, task.metadata.id);
  if (!existsSync(path)) return;
  const existing = readFileSync(path, 'utf8');
  const start = existing.indexOf(PRD_START);
  const end = existing.indexOf(PRD_END);
  if (start < 0 || end <= start) return;
  const next = `${existing.slice(0, start)}${existing.slice(end + PRD_END.length)}`.trimEnd() + '\n';
  writeTextAtomic(path, next);
}

export function taskFinalizationIsCurrent(root: string, task: TestTask, run: TestRun): boolean {
  return task.finalization?.status === 'completed'
    && task.finalization.sourceRunId === run.id
    && task.prdRef === 'prd.md'
    && existsSync(taskPrdPath(root, task.metadata.moduleId, task.metadata.id));
}

export function finalizeTask(root: string, moduleId: string, taskId: string, sourceRunId?: string): TaskFinalizationResult {
  return withFileLock(qaPath(root, '.locks', `finalize-${moduleId}-${taskId}.lock`), () => {
    let task = readTask(root, moduleId, taskId);
    const run = sourceRunId ? readRunById(root, sourceRunId) : latestCompletedRun(root, task);
    if (!run || !run.completedAt) throw new Error(`Task ${moduleId}/${taskId} has no completed Run to finalize.`);
    if (run.moduleId !== moduleId || run.taskId !== taskId) throw new Error(`Run ${run.id} does not belong to ${moduleId}/${taskId}.`);
    if (task.metadata.mode !== 'quick') throw new Error('Automatic Task Finalizer applies only to Quick Tasks.');
    if (run.planHash !== testPlanHash(task)) throw new Error(`Run ${run.id} does not match the current Quick Task execution contract.`);

    const prdPath = taskPrdPath(root, moduleId, taskId);
    if (taskFinalizationIsCurrent(root, task, run)) {
      return { apiVersion: 'qa-agent/task-finalization/v1', kind: 'TaskFinalizationResult', status: 'completed', moduleId, taskId, sourceRunId: run.id, prdPath, artifactHash: task.finalization?.artifactHash };
    }

    const state = normalizeTaskState(task.metadata.status);
    if (!['reviewing_result', 'completed'].includes(state)) throw new Error(`Task ${taskId} is ${state}; only a completed Quick Run result can be finalized.`);
    const timestamp = now();
    task.prdRef = 'prd.md';
    task.finalization = {
      status: 'in_progress', sourceRunId: run.id, prdRef: 'prd.md',
      startedAt: task.finalization?.sourceRunId === run.id ? task.finalization.startedAt ?? timestamp : timestamp,
      updatedAt: timestamp,
    };
    saveTask(root, task);

    try {
      if (!run.reportPath || run.reportGeneratedBy !== 'qa-agent-runtime' || !existsSync(taskSourceRunReportPath(root, moduleId, taskId))) throw new Error(`Source Run ${run.id} does not have an authoritative Runtime report.`);
      for (const screenshot of run.screenshots) verifiedRunAsset(root, task, run, screenshot.path);
      const generated = generatedPrdSection(root, task, run);
      const prd = upsertGeneratedPrd(existsSync(prdPath) ? readFileSync(prdPath, 'utf8') : undefined, task, generated);
      writeTextAtomic(prdPath, prd);
      const hash = createHash('sha256').update(prd).digest('hex');

      task = readTask(root, moduleId, taskId);
      task.prdRef = 'prd.md';
      task.finalization = {
        status: 'completed', sourceRunId: run.id, prdRef: 'prd.md',
        startedAt: task.finalization?.startedAt ?? timestamp, finalizedAt: now(), updatedAt: now(), artifactHash: hash,
      };
      if (normalizeTaskState(task.metadata.status) === 'reviewing_result') transitionTaskState(root, task, 'completed', 'task_finalized', 'task_prd_updated', { artifactHash: hash, idempotencyKey: `task-finalized:${run.id}:${hash}`, metadata: { runId: run.id, prdRef: 'prd.md' } });
      task.metadata.version += 1;
      task.updatedAt = now();
      saveTask(root, task);
      rebuildIndexes(root);
      return { apiVersion: 'qa-agent/task-finalization/v1', kind: 'TaskFinalizationResult', status: 'completed', moduleId, taskId, sourceRunId: run.id, prdPath, artifactHash: hash };
    } catch (error) {
      task = readTask(root, moduleId, taskId);
      task.finalization = {
        status: 'failed', sourceRunId: run.id, prdRef: 'prd.md',
        startedAt: task.finalization?.startedAt ?? timestamp, updatedAt: now(), error: (error as Error).message,
      };
      task.updatedAt = now();
      saveTask(root, task);
      rebuildIndexes(root);
      return { apiVersion: 'qa-agent/task-finalization/v1', kind: 'TaskFinalizationResult', status: 'failed', moduleId, taskId, sourceRunId: run.id, error: (error as Error).message };
    }
  });
}
