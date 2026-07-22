import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalIsCurrent, testPlanHash } from './approval.ts';
import { listPythonRegressions } from './python-regression.ts';
import { listFiles, readJson } from './store.ts';
import { taskDirectory, taskModuleSnapshotPath, taskPlanPath, taskRequirementsPath, taskRunReportPath } from './project.ts';
import { validateProject } from './validation.ts';
import { hasRuntimeReportMarker } from './report-contract.ts';
import type { PythonRegressionRun, TestRun, TestTask } from './types.ts';

export interface ArchiveCheck { id: string; label: string; status: 'passed' | 'failed'; details: string[] }
export interface ArchiveInspection { valid: boolean; taskDirectory: string; checks: ArchiveCheck[]; missing: string[]; errors: string[]; suggestions: string[] }
function check(checks: ArchiveCheck[], id: string, label: string, ok: boolean, details: string[]): void { checks.push({ id, label, status: ok ? 'passed' : 'failed', details }); }
function requiredFile(path: string, checks: ArchiveCheck[], missing: string[], id: string, label: string): void { const ok = existsSync(path); if (!ok) missing.push(path); check(checks, id, label, ok, ok ? [path] : [`Missing ${path}`]); }

export function inspectTaskArchive(root: string, task: TestTask): ArchiveInspection {
  const directory = taskDirectory(root, task.metadata.moduleId, task.metadata.id);
  const checks: ArchiveCheck[] = []; const missing: string[] = []; const errors: string[] = [];
  for (const [path, label] of [[join(directory, 'task.json'), 'Task manifest'], [taskModuleSnapshotPath(root, task.metadata.moduleId, task.metadata.id), 'Module snapshot'], [taskRequirementsPath(root, task.metadata.moduleId, task.metadata.id), 'Requirements'], [taskPlanPath(root, task.metadata.moduleId, task.metadata.id), 'Test plan']] as const) requiredFile(path, checks, missing, label.toLowerCase().replace(/[^a-z]+/g, '-'), label);
  for (const scenario of task.scenarios) requiredFile(join(directory, 'scenarios', `${scenario.id}.json`), checks, missing, `scenario-${scenario.id}`, `Scenario ${scenario.id}`);

  const backgroundOk = Boolean(task.description.trim() && task.objectives.length && task.scope.platforms.length && task.scope.environments.length && task.scope.roles.length && task.requirements?.businessGoals?.length && task.moduleSnapshot?.moduleName && task.moduleSnapshot?.snapshotHash);
  check(checks, 'background', 'Task background completeness', backgroundOk, backgroundOk ? ['description, objectives, scope, business goals, and module snapshot are present'] : ['description, objectives, scope, requirements.businessGoals, and module snapshot are all required']);
  const approvalRequired = task.metadata.approvalPolicy !== 'side-effect-only';
  const approved = !approvalRequired || (approvalIsCurrent(task) && task.testPlan?.status === 'approved' && task.testPlan.planHash === testPlanHash(task));
  check(checks, 'approval', 'Current execution approval', approved, approved ? [approvalRequired ? `planHash=${testPlanHash(task)}` : 'Quick Task does not require TestPlan approval'] : ['Strict Task must have current human approval and a matching approved TestPlan']);

  const scripts = listPythonRegressions(root, task.metadata.moduleId, task.metadata.id).filter(script => script.status === 'validated' && script.sourcePlanHash === testPlanHash(task));
  const coveredScenarios = new Set(scripts.flatMap(script => script.scenarioIds));
  const regressionCovered = task.scenarios.length > 0 && task.scenarios.every(scenario => coveredScenarios.has(scenario.id));
  check(checks, 'python-regression-coverage', 'Validated Python regression covers every Scenario', regressionCovered, regressionCovered ? scripts.map(script => `${script.id}: ${script.scenarioIds.join(', ')}`) : task.scenarios.filter(scenario => !coveredScenarios.has(scenario.id)).map(scenario => `Scenario ${scenario.id} needs a validated Python regression script with the current plan hash`));

  const regressionRuns = listFiles(join(directory, 'regression-runs'), path => path.endsWith('/run.json')).map(path => { try { return readJson<PythonRegressionRun>(path); } catch { return undefined; } }).filter((run): run is PythonRegressionRun => Boolean(run));
  const scriptsValidatedByRuns = scripts.every(script => regressionRuns.some(run => run.id === script.validatedByRunId && run.regressionId === script.id && run.contractStatus === 'completed'));
  check(checks, 'python-regression-validation', 'Every formal script has a completed execution contract', scriptsValidatedByRuns, scriptsValidatedByRuns ? [`${scripts.length} validated script(s)`] : scripts.filter(script => !regressionRuns.some(run => run.id === script.validatedByRunId && run.regressionId === script.id && run.contractStatus === 'completed')).map(script => `${script.id} requires a completed Python regression Run`));

  const runs = listFiles(join(directory, 'runs'), path => /\/run\.json$/.test(path)).map(path => { try { return readJson<TestRun>(path); } catch { return undefined; } }).filter((run): run is TestRun => Boolean(run));
  const completedRuns = runs.filter(run => Boolean(run.completedAt)).sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt));
  const latest = completedRuns[0];
  const latestResolved = Boolean(latest && ['passed', 'adapted'].includes(latest.status));
  check(checks, 'latest-run', 'Latest completed exploratory Run is resolved', latestResolved, latestResolved ? [`${latest!.id}: ${latest!.status}`] : [latest ? `${latest.id}: ${latest.status}; resolve and rerun before archive` : 'No completed Runtime Run exists']);
  const successful = runs.filter(run => ['passed', 'adapted'].includes(run.status) && Boolean(run.completedAt) && run.reportGeneratedBy === 'qa-agent-runtime');
  const evidenceOk = successful.some(run => { const reportPath = taskRunReportPath(root, task.metadata.moduleId, task.metadata.id, run.id); if (!existsSync(reportPath)) return false; const report = readFileSync(reportPath, 'utf8'); return hasRuntimeReportMarker(report, run.id) && /!\[[^\]]*\]\([^\)]+\)/.test(report) && run.screenshots.length > 0 && run.screenshots.every(item => existsSync(join(directory, 'runs', run.id, item.path))); });
  check(checks, 'successful-run', 'Successful Runtime Run with report and screenshots', evidenceOk, evidenceOk ? [`${successful.length} successful Run(s) with Runtime-owned evidence`] : ['At least one passed/adapted Run must include run.json, Runtime-owned report.md, existing screenshots, and Markdown image evidence']);

  const unresolvedKnownIssues = listFiles(join(directory, 'memory'), path => path.endsWith('.json')).map(path => { try { return readJson<{ id: string; type: string; status: string }>(path); } catch { return undefined; } }).filter((item): item is { id: string; type: string; status: string } => Boolean(item && item.type === 'known_issue' && item.status === 'candidate'));
  check(checks, 'known-issues', 'No unresolved known-issue candidates', unresolvedKnownIssues.length === 0, unresolvedKnownIssues.length ? unresolvedKnownIssues.map(item => `${item.id} requires review, rejection, or resolution`) : ['no candidate known_issue memory remains']);

  const validation = validateProject(root);
  if (!validation.valid) errors.push(...validation.errors);
  check(checks, 'validation', 'Project asset validation', validation.valid, validation.valid ? ['project validation passed'] : validation.errors);
  const valid = missing.length === 0 && errors.length === 0 && checks.every(item => item.status === 'passed');
  return { valid, taskDirectory: directory, checks, missing, errors, suggestions: valid ? ['Preserve the Task definition, source Runs, approved Python scripts, regression Runs, reports, screenshots, and memory.'] : ['Repair each failed Task asset gate, then rerun qa-agent archive.'] };
}
