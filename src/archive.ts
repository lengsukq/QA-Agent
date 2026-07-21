import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalIsCurrent, testPlanHash } from './approval.ts';
import { listOperations } from './operations.ts';
import { readJson, listFiles } from './store.ts';
import { taskDirectory, taskModuleSnapshotPath, taskPlanPath, taskRegressionSuitePath, taskRequirementsPath, taskRunReportPath } from './project.ts';
import { validateProject } from './validation.ts';
import { hasRuntimeReportMarker } from './report-contract.ts';
import type { OperationPlan, RegressionSuite, TestRun, TestTask } from './types.ts';

export interface ArchiveCheck { id: string; label: string; status: 'passed' | 'failed'; details: string[] }
export interface ArchiveInspection { valid: boolean; taskDirectory: string; checks: ArchiveCheck[]; missing: string[]; errors: string[]; suggestions: string[] }

function check(checks: ArchiveCheck[], id: string, label: string, ok: boolean, details: string[]): void {
  checks.push({ id, label, status: ok ? 'passed' : 'failed', details });
}
function requiredFile(path: string, checks: ArchiveCheck[], missing: string[], id: string, label: string): boolean {
  const ok = existsSync(path);
  if (!ok) missing.push(path);
  check(checks, id, label, ok, ok ? [path] : [`Missing ${path}`]);
  return ok;
}

export function inspectTaskArchive(root: string, task: TestTask): ArchiveInspection {
  const directory = taskDirectory(root, task.metadata.moduleId, task.metadata.id);
  const checks: ArchiveCheck[] = []; const missing: string[] = []; const errors: string[] = [];
  const fileChecks = [
    [join(directory, 'task.json'), 'Task manifest'], [taskModuleSnapshotPath(root, task.metadata.moduleId, task.metadata.id), 'Module snapshot'],
    [taskRequirementsPath(root, task.metadata.moduleId, task.metadata.id), 'Requirements'], [taskPlanPath(root, task.metadata.moduleId, task.metadata.id), 'Test plan'],
    [taskRegressionSuitePath(root, task.metadata.moduleId, task.metadata.id), 'RegressionSuite'],
  ] as const;
  for (const [path, label] of fileChecks) requiredFile(path, checks, missing, label.toLowerCase().replace(/[^a-z]+/g, '-'), label);
  for (const scenario of task.scenarios) requiredFile(join(directory, 'scenarios', `${scenario.id}.json`), checks, missing, `scenario-${scenario.id}`, `Scenario ${scenario.id}`);

  const backgroundOk = Boolean(task.description.trim() && task.objectives.length && task.scope.platforms.length && task.scope.environments.length && task.scope.roles.length && task.requirements?.businessGoals?.length && task.moduleSnapshot?.moduleName && task.moduleSnapshot?.snapshotHash);
  check(checks, 'background', 'Task background completeness', backgroundOk, backgroundOk ? ['description, objectives, scope, business goals, and module snapshot are present'] : ['description, objectives, scope, requirements.businessGoals, and module snapshot are all required']);
  const approved = approvalIsCurrent(task) && task.testPlan?.status === 'approved' && task.testPlan.planHash === testPlanHash(task);
  check(checks, 'approval', 'Human approval and current plan hash', approved, approved ? [`planHash=${testPlanHash(task)}`] : ['Task must have current human approval and an approved TestPlan with matching planHash']);

  let operations: OperationPlan[] = [];
  try { operations = listOperations(root, task); } catch (error) { errors.push(`OperationPlan read failed: ${(error as Error).message}`); }
  const activeByScenario = new Map(task.scenarios.map(scenario => [scenario.id, operations.find(plan => plan.status === 'active' && plan.validationStatus === 'passed' && plan.scenarioId === scenario.id && plan.planHash === testPlanHash(task) && plan.steps.length > 0)]));
  const operationsOk = task.scenarios.length > 0 && task.scenarios.every(scenario => Boolean(activeByScenario.get(scenario.id)));
  check(checks, 'operation-plans', 'Validated active OperationPlan per Scenario', operationsOk, operationsOk ? [`${task.scenarios.length} active OperationPlan(s) passed a real replay Run`] : task.scenarios.filter(s => !activeByScenario.get(s.id)).map(s => `Scenario ${s.id} needs an active OperationPlan with the current planHash and validationStatus=passed from a successful replay Run`));

  let suite: RegressionSuite | undefined;
  if (existsSync(taskRegressionSuitePath(root, task.metadata.moduleId, task.metadata.id))) {
    try { suite = readJson<RegressionSuite>(taskRegressionSuitePath(root, task.metadata.moduleId, task.metadata.id)); } catch (error) { errors.push(`RegressionSuite read failed: ${(error as Error).message}`); }
  }
  const covered = Boolean(suite && suite.status === 'active' && suite.scope === 'task' && suite.taskId === task.metadata.id && task.scenarios.every(scenario => suite!.members.some(member => member.scenarioId === scenario.id && member.operationPlanId === activeByScenario.get(scenario.id)?.id && member.taskPlanHash === testPlanHash(task))));
  check(checks, 'regression-suite', 'RegressionSuite covers every Scenario', covered, covered ? ['all scenarios and active OperationPlans are covered'] : ['RegressionSuite must be active and cover every Scenario with its current active OperationPlan']);

  const runs = listFiles(join(directory, 'runs'), path => /\/run\.json$/.test(path)).map(path => { try { return readJson<TestRun>(path); } catch { return undefined; } }).filter((run): run is TestRun => Boolean(run));
  const successful = runs.filter(run => ['passed', 'adapted'].includes(run.status) && Boolean(run.completedAt) && run.reportGeneratedBy === 'qa-agent-runtime');
  const runEvidenceOk = successful.some(run => {
    const reportPath = taskRunReportPath(root, task.metadata.moduleId, task.metadata.id, run.id);
    if (!existsSync(reportPath)) return false;
    const report = readFileSync(reportPath, 'utf8');
    return hasRuntimeReportMarker(report, run.id) && /!\[[^\]]*\]\([^\)]+\)/.test(report) && run.screenshots.length > 0 && run.screenshots.every(screenshot => existsSync(join(directory, 'runs', run.id, screenshot.path)));
  });
  check(checks, 'successful-run', 'Successful Runtime Run with report and screenshots', runEvidenceOk, runEvidenceOk ? [`${successful.length} successful Run(s) with Runtime report and image evidence`] : ['At least one passed/adapted Runtime Run must include run.json, Runtime-owned report.md, existing screenshots, and Markdown image evidence']);
  const regressionSuccessful = successful.filter(run => ['replayed', 'adapted'].includes(run.replayStatus));
  const regressionEvidenceOk = regressionSuccessful.some(run => {
    const reportPath = taskRunReportPath(root, task.metadata.moduleId, task.metadata.id, run.id);
    if (!existsSync(reportPath)) return false;
    const report = readFileSync(reportPath, 'utf8');
    return hasRuntimeReportMarker(report, run.id) && /!\[[^\]]*\]\([^\)]+\)/.test(report) && run.screenshots.length > 0 && run.screenshots.every(screenshot => existsSync(join(directory, 'runs', run.id, screenshot.path)));
  });
  check(checks, 'successful-regression-run', 'Successful OperationPlan regression Run with report and screenshots', regressionEvidenceOk, regressionEvidenceOk ? [`${regressionSuccessful.length} successful regression Run(s) with Runtime report and image evidence`] : ['Run the approved OperationPlan through qa-agent test and complete a successful replay/adapted Run before archiving']);

  const validation = validateProject(root);
  if (!validation.valid) errors.push(...validation.errors);
  check(checks, 'validation', 'Project JSON and report validation', validation.valid, validation.valid ? ['existing project validation passed'] : validation.errors);
  const valid = missing.length === 0 && errors.length === 0 && checks.every(item => item.status === 'passed');
  return { valid, taskDirectory: directory, checks, missing, errors, suggestions: valid ? ['Preserve the Task directory, OperationPlans, RegressionSuite, Run report, screenshots, and memory candidates.'] : ['Review each failed check, repair assets inside this Task directory, then rerun qa-agent archive.'] };
}
