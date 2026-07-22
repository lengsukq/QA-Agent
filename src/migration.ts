import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { qaPath, readTask, saveTask, taskDirectory, taskRunDirectory } from './project.ts';
import { appendTaskEvent, readTaskEvents } from './events.ts';
import { normalizeTaskState } from './workflow-model.ts';
import { testPlanHash } from './approval.ts';
import { inspectPythonRegressionEligibility } from './python-regression.ts';
import { RUNTIME_REPORT_GENERATOR, runtimeReportMarker } from './report-contract.ts';
import { listFiles, now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type { RegressionRun, TestRun, TestTask } from './types.ts';

export interface MigrationResult {
  migratedTaskReports: number;
  migratedRunIndexes: number;
  updatedRuns: number;
  updatedTasks: number;
  quarantinedOrphanReports: number;
  normalizedTaskStates: number;
  createdTaskEventLogs: number;
  backfilledScenarioAssertions: number;
  backfilledScenarioPlanning: number;
  backfilledRequirementTrace: number;
  rehashedApprovedPlans: number;
  backfilledRunPlanHashes: number;
  removedOperationPlanDirectories: number;
  removedRegressionSuites: number;
  migratedPythonRegressions: number;
  migratedPythonDrafts: number;
  removedLegacyRegressionRuns: number;
  warnings: string[];
}

function copyThenRemove(source: string, destination: string): void { mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination); unlinkSync(source); }
function ensureRuntimeMarker(path: string, runId: string): void { const text = readFileSync(path, 'utf8'); const marker = runtimeReportMarker(runId); if (!text.includes(marker)) writeTextAtomic(path, `${marker}\n${text}`); }
function hash(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }

function validGlobalReport(root: string, path: string): boolean {
  const id = basename(path, '.md');
  if (existsSync(qaPath(root, 'release-checks', `${id}.json`))) return true;
  const regressionPath = qaPath(root, 'regression-runs', `${id}.json`);
  if (!existsSync(regressionPath)) return false;
  try { return readJson<RegressionRun>(regressionPath).selectionScope === 'release'; } catch { return false; }
}

function legacyWorkflowV2PlanHash(task: TestTask): string {
  const legacy = structuredClone(task);
  if (legacy.requirements) delete legacy.requirements.requirementTrace;
  for (const scenario of legacy.scenarios) {
    for (const assertion of scenario.visualAssertions ?? []) delete (assertion as Partial<typeof assertion>).importance;
    delete scenario.planningStatus; delete scenario.priority; delete scenario.requirementRefs; delete scenario.sourceRefs; delete scenario.deferredReason;
  }
  return testPlanHash(legacy);
}

function replaceScriptMetadata(script: string, metadata: Record<string, unknown>): string {
  const line = `# QA_AGENT_REGRESSION: ${JSON.stringify(metadata)}`;
  const pattern = /^# QA_AGENT_REGRESSION: .*$/m;
  return pattern.test(script) ? script.replace(pattern, line) : `${line}\n${script}`;
}

function migratePythonAsset(root: string, task: TestTask, manifestPath: string, draft: boolean, result: MigrationResult): void {
  const raw = readJson<Record<string, any>>(manifestPath);
  const scriptPath = join(dirname(manifestPath), draft ? `${raw.id}.py` : basename(raw.scriptRef ?? `${raw.id}.py`));
  if (!existsSync(scriptPath)) { result.warnings.push(`Python regression script is missing: ${scriptPath}`); return; }
  const runPath = join(taskDirectory(root, task.metadata.moduleId, task.metadata.id), 'runs', String(raw.sourceRunId), 'run.json');
  let sourceRun: TestRun | undefined;
  try { if (existsSync(runPath)) sourceRun = readJson<TestRun>(runPath); } catch { /* handled below */ }
  let scenarioIds: string[] = Array.isArray(raw.scenarioIds) ? raw.scenarioIds : [];
  let sourceStepIds: string[] = Array.isArray(raw.sourceStepIds) ? raw.sourceStepIds : [];
  let sourceFlowHash: string | undefined;
  if (sourceRun) {
    const eligibility = inspectPythonRegressionEligibility(task, sourceRun);
    scenarioIds = eligibility.scenarioIds.length ? eligibility.scenarioIds : scenarioIds;
    sourceStepIds = eligibility.sourceStepIds.length ? eligibility.sourceStepIds : sourceStepIds;
    sourceFlowHash = eligibility.flowHash;
    if (!eligibility.eligible && !draft) { raw.status = 'stale'; raw.staleReason = 'Legacy script source Run no longer satisfies Python-only regression eligibility.'; }
  }
  if (!scenarioIds.length) scenarioIds = task.scenarios.filter(scenario => sourceRun?.scenarioId ? scenario.id === sourceRun.scenarioId : true).map(scenario => scenario.id);
  sourceFlowHash ??= hash({ sourceRunId: raw.sourceRunId, sourceStepIds, scenarioIds, legacy: true });
  const script = readFileSync(scriptPath, 'utf8');
  const migratedScript = replaceScriptMetadata(script, { scriptId: raw.id, sourceRunId: raw.sourceRunId, sourceStepIds, sourceFlowHash });
  writeTextAtomic(scriptPath, migratedScript.endsWith('\n') ? migratedScript : `${migratedScript}\n`);
  raw.apiVersion = draft ? 'qa-agent/python-regression-draft/v2' : 'qa-agent/python-regression/v2';
  raw.sourceStepIds = sourceStepIds;
  raw.scenarioIds = scenarioIds;
  raw.sourceFlowHash = sourceFlowHash;
  raw.scriptHash = hash(migratedScript.endsWith('\n') ? migratedScript : `${migratedScript}\n`);
  delete raw.sourceOperationPlanIds;
  raw.updatedAt = now();
  writeJsonAtomic(manifestPath, raw);
  if (draft) result.migratedPythonDrafts += 1; else result.migratedPythonRegressions += 1;
}

export function migrateProjectArtifacts(root: string): MigrationResult {
  const result: MigrationResult = { migratedTaskReports: 0, migratedRunIndexes: 0, updatedRuns: 0, updatedTasks: 0, quarantinedOrphanReports: 0, normalizedTaskStates: 0, createdTaskEventLogs: 0, backfilledScenarioAssertions: 0, backfilledScenarioPlanning: 0, backfilledRequirementTrace: 0, rehashedApprovedPlans: 0, backfilledRunPlanHashes: 0, removedOperationPlanDirectories: 0, removedRegressionSuites: 0, migratedPythonRegressions: 0, migratedPythonDrafts: 0, removedLegacyRegressionRuns: 0, warnings: [] };
  const taskPaths = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path));
  for (const taskPath of taskPaths) {
    const raw = readJson<Record<string, any>>(taskPath);
    const task = readTask(root, raw.metadata.moduleId, raw.metadata.id);
    const taskDir = dirname(taskPath); const legacyReportsDir = join(taskDir, 'reports'); const runDir = join(taskDir, 'runs');
    const previousApprovedHash = task.metadata.approval?.planHash;
    let taskChanged = false; let schemaBackfillChanged = false;
    const legacyTask = task as TestTask & { summaryRef?: string; observedScenarioRefs?: string[]; observedScenarios?: unknown; operationPlanRefs?: string[]; regressionSuiteRef?: string; finalization?: TestTask['finalization'] & { summaryRef?: string; observedScenarioRefs?: string[] } };
    if (legacyTask.summaryRef !== undefined || legacyTask.observedScenarioRefs !== undefined || legacyTask.observedScenarios !== undefined) {
      for (const ref of legacyTask.observedScenarioRefs ?? []) { const path = join(taskDir, ref); if (/^scenarios\/observed-[a-z0-9-]+\.json$/.test(ref) && existsSync(path)) unlinkSync(path); }
      if (existsSync(join(taskDir, 'summary.md'))) unlinkSync(join(taskDir, 'summary.md'));
      delete legacyTask.summaryRef; delete legacyTask.observedScenarioRefs; delete legacyTask.observedScenarios;
      if (legacyTask.finalization) { delete legacyTask.finalization.summaryRef; delete legacyTask.finalization.observedScenarioRefs; }
      taskChanged = true;
    }
    if (legacyTask.operationPlanRefs !== undefined) { delete legacyTask.operationPlanRefs; taskChanged = true; }
    if (legacyTask.regressionSuiteRef !== undefined) { delete legacyTask.regressionSuiteRef; taskChanged = true; }
    const operationDirectory = join(taskDir, 'operation-plans');
    if (existsSync(operationDirectory)) { rmSync(operationDirectory, { recursive: true, force: true }); result.removedOperationPlanDirectories += 1; }
    const suitePath = join(taskDir, 'regression-suite.json');
    if (existsSync(suitePath)) { unlinkSync(suitePath); result.removedRegressionSuites += 1; }

    for (const scenario of task.scenarios) {
      for (const assertion of scenario.visualAssertions ?? []) if (!assertion.importance) { assertion.importance = scenario.risk; result.backfilledScenarioAssertions += 1; taskChanged = true; schemaBackfillChanged = true; }
      if (!scenario.planningStatus) { scenario.planningStatus = 'applicable'; result.backfilledScenarioPlanning += 1; taskChanged = true; schemaBackfillChanged = true; }
      if (!scenario.priority) { scenario.priority = task.metadata.priority; result.backfilledScenarioPlanning += 1; taskChanged = true; schemaBackfillChanged = true; }
      if (!scenario.requirementRefs?.length) { scenario.requirementRefs = [`requirement-${scenario.id}`]; result.backfilledScenarioPlanning += 1; taskChanged = true; schemaBackfillChanged = true; }
      if (!scenario.sourceRefs) { scenario.sourceRefs = task.requirements?.sourceRefs ?? []; result.backfilledScenarioPlanning += 1; taskChanged = true; schemaBackfillChanged = true; }
    }
    if (task.requirements && !task.requirements.requirementTrace?.length) { task.requirements.requirementTrace = task.scenarios.map(scenario => ({ requirementId: scenario.requirementRefs?.[0] ?? `requirement-${scenario.id}`, scenarioIds: [scenario.id], assertionIds: (scenario.visualAssertions ?? []).map(assertion => assertion.id), sourceRefs: scenario.sourceRefs ?? task.requirements?.sourceRefs ?? [], status: 'covered' })); result.backfilledRequirementTrace += task.requirements.requirementTrace.length; taskChanged = true; schemaBackfillChanged = true; }
    const normalizedState = normalizeTaskState(task.metadata.status);
    if (task.metadata.status !== normalizedState) { task.metadata.status = normalizedState; task.updatedAt = now(); taskChanged = true; result.normalizedTaskStates += 1; }
    const currentPlanHash = testPlanHash(task); const legacyPlanHash = legacyWorkflowV2PlanHash(task);
    const canRehash = Boolean(previousApprovedHash && previousApprovedHash !== currentPlanHash && previousApprovedHash === legacyPlanHash && task.metadata.approval);
    if (canRehash && task.metadata.approval) { task.metadata.approval.planHash = currentPlanHash; if (task.testPlan) { task.testPlan.planHash = currentPlanHash; task.testPlan.status = 'approved'; task.testPlan.approvedBy = task.metadata.approval.confirmedBy; task.testPlan.approvedAt = task.metadata.approval.confirmedAt; task.testPlan.updatedAt = now(); } task.updatedAt = now(); taskChanged = true; result.rehashedApprovedPlans += 1; }

    for (const runPath of listFiles(runDir, path => path.endsWith('/run.json'))) {
      const run = readJson<Record<string, any>>(runPath);
      if (!run.planHash && task.metadata.approval && run.startedAt >= task.metadata.approval.confirmedAt) { run.planHash = task.metadata.approval.planHash; result.backfilledRunPlanHashes += 1; }
      for (const step of run.steps ?? []) {
        if (step.operationAction !== undefined && step.uiAction === undefined) step.uiAction = step.operationAction;
        delete step.operationAction;
      }
      for (const key of ['operationPlanId', 'operationVersion', 'operationCandidates', 'operationCandidateIssues', 'replayStatus', 'replayStage', 'replayCursor']) delete run[key];
      run.mode = 'explore';
      if (run.completedAt) {
        try { const eligibility = inspectPythonRegressionEligibility(task, run as TestRun); run.pythonRegressionEligibility = eligibility; } catch { /* preserve historical run */ }
      }
      writeJsonAtomic(runPath, run); result.updatedRuns += 1;
    }

    if (!readTaskEvents(root, task.metadata.moduleId, task.metadata.id).length) { appendTaskEvent(root, { type: 'migration_baseline_created', actor: { type: 'migration', id: 'qa-agent-migrate' }, moduleId: task.metadata.moduleId, taskId: task.metadata.id, toState: normalizedState, reasonCode: 'python_only_regression_baseline', artifactHash: task.metadata.approval?.planHash, idempotencyKey: `migration-baseline:${task.metadata.moduleId}:${task.metadata.id}:python-only`, metadata: { previousStatus: raw.metadata.status, normalizedStatus: normalizedState } }); result.createdTaskEventLogs += 1; }
    if (canRehash && previousApprovedHash) appendTaskEvent(root, { type: 'migration_plan_hash_updated', actor: { type: 'migration', id: 'qa-agent-migrate' }, moduleId: task.metadata.moduleId, taskId: task.metadata.id, fromState: normalizedState, toState: normalizedState, reasonCode: 'deterministic_schema_backfill', artifactHash: currentPlanHash, idempotencyKey: `migration-plan-hash:${task.metadata.moduleId}:${task.metadata.id}:${previousApprovedHash}:${currentPlanHash}`, metadata: { previousPlanHash: previousApprovedHash, currentPlanHash, schemaBackfillChanged } });

    if (taskChanged) { saveTask(root, task); result.updatedTasks += 1; }
    const currentTask = readTask(root, task.metadata.moduleId, task.metadata.id);
    for (const manifestPath of listFiles(join(taskDir, 'regression'), path => path.endsWith('.json'))) migratePythonAsset(root, currentTask, manifestPath, false, result);

    for (const reportPath of listFiles(legacyReportsDir, path => /^run-[^/]+\.md$/.test(basename(path)))) {
      const runId = basename(reportPath, '.md'); const runJsonPath = join(taskRunDirectory(root, task.metadata.moduleId, task.metadata.id, runId), 'run.json');
      if (!existsSync(runJsonPath)) { result.warnings.push(`Legacy report has no matching Run and was left in place: ${reportPath}`); continue; }
      const destination = join(taskRunDirectory(root, task.metadata.moduleId, task.metadata.id, runId), 'report.md');
      if (!existsSync(destination)) copyThenRemove(reportPath, destination); else unlinkSync(reportPath);
      ensureRuntimeMarker(destination, runId); const run = readJson<Record<string, any>>(runJsonPath); run.reportPath = `runs/${runId}/report.md`; run.reportGeneratedBy = RUNTIME_REPORT_GENERATOR; run.reportGeneratedAt ??= run.completedAt ?? now(); writeJsonAtomic(runJsonPath, run); result.migratedTaskReports += 1;
    }
    for (const name of ['index.json', 'latest.json']) { const source = join(legacyReportsDir, name); const destination = join(runDir, name); if (!existsSync(source)) continue; if (!existsSync(destination)) copyThenRemove(source, destination); else unlinkSync(source); result.migratedRunIndexes += 1; }
    if (task.reportIndexRef !== 'runs/index.json') { task.reportIndexRef = 'runs/index.json'; task.updatedAt = now(); saveTask(root, task); result.updatedTasks += 1; }
    if (existsSync(legacyReportsDir) && listFiles(legacyReportsDir, () => true).length === 0) rmSync(legacyReportsDir, { recursive: true, force: true });
  }

  for (const draftPath of listFiles(qaPath(root, '.runtime', 'drafts'), path => path.endsWith('/draft.json'))) { const raw = readJson<Record<string, any>>(draftPath); try { const task = readTask(root, raw.moduleId, raw.taskId); migratePythonAsset(root, task, draftPath, true, result); } catch (error) { result.warnings.push(`Could not migrate Python draft ${draftPath}: ${(error as Error).message}`); } }
  for (const path of listFiles(qaPath(root, 'regression-runs'), item => item.endsWith('.json'))) { try { const value = readJson<Record<string, any>>(path); if (value.kind !== 'PythonRegressionBatchRun') { unlinkSync(path); result.removedLegacyRegressionRuns += 1; } } catch { unlinkSync(path); result.removedLegacyRegressionRuns += 1; } }

  const globalReports = qaPath(root, 'reports');
  for (const reportPath of listFiles(globalReports, path => path.endsWith('.md'))) { if (validGlobalReport(root, reportPath)) continue; copyThenRemove(reportPath, qaPath(root, 'orphans', 'reports', relative(globalReports, reportPath))); result.quarantinedOrphanReports += 1; }
  return result;
}
