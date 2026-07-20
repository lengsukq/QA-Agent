import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { qaPath, readTask, saveTask, taskRunDirectory } from './project.ts';
import { RUNTIME_REPORT_GENERATOR, runtimeReportMarker } from './report-contract.ts';
import { listFiles, now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type { RegressionRun, TestRun, TestTask } from './types.ts';

export interface MigrationResult {
  migratedTaskReports: number;
  migratedRunIndexes: number;
  updatedRuns: number;
  updatedTasks: number;
  quarantinedOrphanReports: number;
  warnings: string[];
}

function copyThenRemove(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  unlinkSync(source);
}

function ensureRuntimeMarker(path: string, runId: string): void {
  const text = readFileSync(path, 'utf8');
  const marker = runtimeReportMarker(runId);
  if (!text.includes(marker)) writeTextAtomic(path, `${marker}\n${text}`);
}

function validGlobalReport(root: string, path: string): boolean {
  const id = basename(path, '.md');
  if (existsSync(qaPath(root, 'release-checks', `${id}.json`))) return true;
  const regressionPath = qaPath(root, 'regression-runs', `${id}.json`);
  if (!existsSync(regressionPath)) return false;
  try { return readJson<RegressionRun>(regressionPath).suiteScope === 'release'; }
  catch { return false; }
}

export function migrateProjectArtifacts(root: string): MigrationResult {
  const result: MigrationResult = {
    migratedTaskReports: 0,
    migratedRunIndexes: 0,
    updatedRuns: 0,
    updatedTasks: 0,
    quarantinedOrphanReports: 0,
    warnings: [],
  };

  const taskPaths = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path));
  for (const taskPath of taskPaths) {
    const raw = readJson<TestTask>(taskPath);
    const task = readTask(root, raw.metadata.moduleId, raw.metadata.id);
    const taskDir = dirname(taskPath);
    const legacyReportsDir = join(taskDir, 'reports');
    const runDir = join(taskDir, 'runs');

    for (const reportPath of listFiles(legacyReportsDir, path => /^run-[^/]+\.md$/.test(basename(path)))) {
      const runId = basename(reportPath, '.md');
      const runJsonPath = join(taskRunDirectory(root, task.metadata.moduleId, task.metadata.id, runId), 'run.json');
      if (!existsSync(runJsonPath)) {
        result.warnings.push(`Legacy report has no matching Run and was left in place: ${reportPath}`);
        continue;
      }
      const destination = join(taskRunDirectory(root, task.metadata.moduleId, task.metadata.id, runId), 'report.md');
      if (!existsSync(destination)) copyThenRemove(reportPath, destination);
      else unlinkSync(reportPath);
      ensureRuntimeMarker(destination, runId);
      const run = readJson<TestRun>(runJsonPath);
      run.reportPath = `runs/${runId}/report.md`;
      run.reportGeneratedBy = RUNTIME_REPORT_GENERATOR;
      run.reportGeneratedAt ??= run.completedAt ?? now();
      writeJsonAtomic(runJsonPath, run);
      result.migratedTaskReports += 1;
      result.updatedRuns += 1;
    }

    for (const name of ['index.json', 'latest.json']) {
      const source = join(legacyReportsDir, name);
      const destination = join(runDir, name);
      if (!existsSync(source)) continue;
      if (!existsSync(destination)) copyThenRemove(source, destination);
      else unlinkSync(source);
      result.migratedRunIndexes += 1;
    }

    if (task.reportIndexRef !== 'runs/index.json') {
      task.reportIndexRef = 'runs/index.json';
      task.updatedAt = now();
      saveTask(root, task);
      result.updatedTasks += 1;
    }

    if (existsSync(legacyReportsDir) && listFiles(legacyReportsDir, () => true).length === 0) rmSync(legacyReportsDir, { recursive: true, force: true });
  }

  const globalReports = qaPath(root, 'reports');
  for (const reportPath of listFiles(globalReports, path => path.endsWith('.md'))) {
    if (validGlobalReport(root, reportPath)) continue;
    const destination = qaPath(root, 'orphans', 'reports', relative(globalReports, reportPath));
    copyThenRemove(reportPath, destination);
    result.quarantinedOrphanReports += 1;
  }

  if (existsSync(globalReports) && listFiles(globalReports, () => true).length === 0) rmSync(globalReports, { recursive: true, force: true });
  return result;
}
