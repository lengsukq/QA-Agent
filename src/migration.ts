import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { qaPath, readTask, saveTask, taskDirectory, taskSourceRunDirectory, taskSourceRunPath, taskSourceRunReportPath } from './project.ts';
import { appendTaskEvent, readTaskEvents } from './events.ts';
import { normalizeTaskState } from './workflow-model.ts';
import { isExplicitStartConfirmation, testPlanHash } from './approval.ts';
import { inspectPythonRegressionEligibility } from './python-regression.ts';
import { RUNTIME_REPORT_GENERATOR, runtimeReportMarker } from './report-contract.ts';
import { listFiles, now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type { RegressionRun, TestRun, TestTask } from './types.ts';
import { syncManagedRuntimeAssets } from './managed-assets.ts';

export interface MigrationResult {
  migratedTaskReports: number;
  migratedRunIndexes: number;
  migratedSourceRuns: number;
  quarantinedLegacySourceRuns: number;
  removedLegacyRunIndexes: number;
  updatedRuns: number;
  updatedTasks: number;
  quarantinedOrphanReports: number;
  normalizedTaskStates: number;
  createdTaskEventLogs: number;
  backfilledScenarioAssertions: number;
  backfilledScenarioPlanning: number;
  backfilledPlannedSteps: number;
  invalidatedLegacyApprovals: number;
  backfilledRequirementTrace: number;
  rehashedApprovedPlans: number;
  backfilledRunPlanHashes: number;
  removedOperationPlanDirectories: number;
  removedRegressionSuites: number;
  migratedPythonRegressions: number;
  migratedPythonDrafts: number;
  removedLegacyRegressionRuns: number;
  synchronizedSchemas: number;
  removedLegacySchemas: number;
  synchronizedBuiltInSkills: number;
  removedLegacyBuiltInSkills: number;
  updatedProjectVersion: number;
  removedLegacyRuntimeDirectories: number;
  warnings: string[];
}

function copyThenRemove(source: string, destination: string): void { mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination); unlinkSync(source); }
function ensureRuntimeMarker(path: string, runId: string): void { const text = readFileSync(path, 'utf8'); const marker = runtimeReportMarker(runId); if (!text.includes(marker)) writeTextAtomic(path, `${marker}\n${text}`); }
function hash(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }

interface LegacyRunCandidate { run: TestRun; directory: string; currentSource: boolean }

function moveDirectory(source: string, destination: string): void {
  if (source === destination) return;
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  rmSync(source, { recursive: true, force: true });
}

function normalizeSourceAssetPath(value: string | undefined, runId: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  for (const prefix of [`runs/${runId}/`, `source-run/`]) if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  return normalized;
}

function normalizeSourceRun(run: TestRun): TestRun {
  run.mode = 'explore';
  run.reportPath = run.completedAt ? 'source-run/report.md' : undefined;
  for (const step of run.steps ?? []) {
    if ((step as Record<string, unknown>).operationAction !== undefined && step.uiAction === undefined) step.uiAction = (step as Record<string, any>).operationAction;
    delete (step as Record<string, unknown>).operationAction;
    step.screenshotPath = normalizeSourceAssetPath(step.screenshotPath, run.id);
  }
  for (const screenshot of run.screenshots ?? []) screenshot.path = normalizeSourceAssetPath(screenshot.path, run.id) ?? screenshot.path;
  for (const evidence of run.evidence ?? []) evidence.path = normalizeSourceAssetPath(evidence.path, run.id);
  for (const finding of run.visualFindings ?? []) finding.screenshotPath = normalizeSourceAssetPath(finding.screenshotPath, run.id);
  for (const finding of run.cleanupFindings ?? []) finding.screenshotPath = normalizeSourceAssetPath(finding.screenshotPath, run.id);
  for (const key of ['operationPlanId', 'operationVersion', 'operationCandidates', 'operationCandidateIssues', 'replayStatus', 'replayStage', 'replayCursor']) delete (run as unknown as Record<string, unknown>)[key];
  return run;
}

function chooseSourceRun(candidates: LegacyRunCandidate[], task: TestTask, manifests: Array<Record<string, any>>): LegacyRunCandidate | undefined {
  if (!candidates.length) return undefined;
  const newest = (items: LegacyRunCandidate[]): LegacyRunCandidate | undefined => [...items].sort((a, b) => (b.run.completedAt ?? b.run.startedAt).localeCompare(a.run.completedAt ?? a.run.startedAt))[0];
  const running = newest(candidates.filter(item => item.run.status === 'running'));
  if (running) return running;
  const activeSourceIds = new Set(manifests.filter(item => ['approved_unverified', 'validated'].includes(item.status)).map(item => String(item.sourceRunId ?? '')).filter(Boolean));
  const activeSource = newest(candidates.filter(item => activeSourceIds.has(item.run.id)));
  if (activeSource) return activeSource;
  const finalized = task.finalization?.sourceRunId ? candidates.find(item => item.run.id === task.finalization?.sourceRunId) : undefined;
  if (finalized) return finalized;
  return newest(candidates.filter(item => item.run.completedAt && ['passed', 'adapted'].includes(item.run.status)))
    ?? newest(candidates.filter(item => Boolean(item.run.completedAt)))
    ?? newest(candidates);
}

function collectLegacyRuns(taskDir: string): LegacyRunCandidate[] {
  const candidates: LegacyRunCandidate[] = [];
  const current = join(taskDir, 'source-run', 'run.json');
  if (existsSync(current)) {
    try { candidates.push({ run: readJson<TestRun>(current), directory: dirname(current), currentSource: true }); } catch { /* reported later */ }
  }
  for (const runPath of listFiles(join(taskDir, 'runs'), path => path.endsWith('/run.json'))) {
    try { candidates.push({ run: readJson<TestRun>(runPath), directory: dirname(runPath), currentSource: false }); } catch { /* preserve malformed directory below */ }
  }
  return candidates;
}

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
  const runPath = taskSourceRunPath(root, task.metadata.moduleId, task.metadata.id);
  let sourceRun: TestRun | undefined;
  try { if (existsSync(runPath)) { const current = readJson<TestRun>(runPath); if (current.id === raw.sourceRunId) sourceRun = current; } } catch { /* handled below */ }
  let scenarioIds: string[] = Array.isArray(raw.scenarioIds) ? raw.scenarioIds : [];
  let sourceStepIds: string[] = Array.isArray(raw.sourceStepIds) ? raw.sourceStepIds : [];
  let sourceFlowHash: string | undefined;
  if (sourceRun) {
    const eligibility = inspectPythonRegressionEligibility(task, sourceRun);
    scenarioIds = eligibility.scenarioIds.length ? eligibility.scenarioIds : scenarioIds;
    sourceStepIds = eligibility.sourceStepIds.length ? eligibility.sourceStepIds : sourceStepIds;
    sourceFlowHash = eligibility.flowHash;
    if (!eligibility.eligible && !draft) { raw.status = 'stale'; raw.staleReason = 'Legacy script source Run no longer satisfies Python-only regression eligibility.'; }
    raw.sourceReportRef = 'source-run/report.md';
  } else if (!draft) {
    raw.status = 'stale';
    raw.staleReason = 'Legacy script source Run was not selected as the current Task Source Run.';
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
  const managed = syncManagedRuntimeAssets(qaPath(root));
  const result: MigrationResult = { migratedTaskReports: 0, migratedRunIndexes: 0, migratedSourceRuns: 0, quarantinedLegacySourceRuns: 0, removedLegacyRunIndexes: 0, updatedRuns: 0, updatedTasks: 0, quarantinedOrphanReports: 0, normalizedTaskStates: 0, createdTaskEventLogs: 0, backfilledScenarioAssertions: 0, backfilledScenarioPlanning: 0, backfilledPlannedSteps: 0, invalidatedLegacyApprovals: 0, backfilledRequirementTrace: 0, rehashedApprovedPlans: 0, backfilledRunPlanHashes: 0, removedOperationPlanDirectories: 0, removedRegressionSuites: 0, migratedPythonRegressions: 0, migratedPythonDrafts: 0, removedLegacyRegressionRuns: 0, ...managed, removedLegacyRuntimeDirectories: 0, warnings: [] };
  const projectPath = qaPath(root, 'project.json');
  if (existsSync(projectPath)) {
    const project = readJson<Record<string, any>>(projectPath);
    if (project.storage?.runIndexFormat !== undefined) {
      delete project.storage.runIndexFormat;
      project.updatedAt = now();
      writeJsonAtomic(projectPath, project);
      result.removedLegacyRunIndexes += 1;
    }
  }
  const globalRunIndex = qaPath(root, 'index', 'runs.jsonl');
  if (existsSync(globalRunIndex)) { unlinkSync(globalRunIndex); result.removedLegacyRunIndexes += 1; }
  const taskPaths = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path));
  for (const taskPath of taskPaths) {
    const raw = readJson<Record<string, any>>(taskPath);
    const task = readTask(root, raw.metadata.moduleId, raw.metadata.id);
    const taskDir = dirname(taskPath); const legacyReportsDir = join(taskDir, 'reports'); const runDir = join(taskDir, 'runs');
    const previousApprovedHash = task.metadata.approval?.planHash;
    let taskChanged = false; let schemaBackfillChanged = false;
    const legacyTask = task as TestTask & { summaryRef?: string; observedScenarioRefs?: string[]; observedScenarios?: unknown; operationPlanRefs?: string[]; regressionSuiteRef?: string; reportIndexRef?: string; runRefs?: string[]; finalization?: TestTask['finalization'] & { summaryRef?: string; observedScenarioRefs?: string[] } };
    if (legacyTask.summaryRef !== undefined || legacyTask.observedScenarioRefs !== undefined || legacyTask.observedScenarios !== undefined) {
      for (const ref of legacyTask.observedScenarioRefs ?? []) { const path = join(taskDir, ref); if (/^scenarios\/observed-[a-z0-9-]+\.json$/.test(ref) && existsSync(path)) unlinkSync(path); }
      if (existsSync(join(taskDir, 'summary.md'))) unlinkSync(join(taskDir, 'summary.md'));
      delete legacyTask.summaryRef; delete legacyTask.observedScenarioRefs; delete legacyTask.observedScenarios;
      if (legacyTask.finalization) { delete legacyTask.finalization.summaryRef; delete legacyTask.finalization.observedScenarioRefs; }
      taskChanged = true;
    }
    if (legacyTask.operationPlanRefs !== undefined) { delete legacyTask.operationPlanRefs; taskChanged = true; }
    if (legacyTask.regressionSuiteRef !== undefined) { delete legacyTask.regressionSuiteRef; taskChanged = true; }
    if (legacyTask.reportIndexRef !== undefined) { delete legacyTask.reportIndexRef; taskChanged = true; }
    if (legacyTask.runRefs !== undefined) { delete legacyTask.runRefs; taskChanged = true; }
    if ((task.metadata.approvalPolicy as string | undefined) !== 'test-plan-and-side-effects') { task.metadata.approvalPolicy = 'test-plan-and-side-effects'; taskChanged = true; }
    if (task.metadata.approval && !isExplicitStartConfirmation(task.metadata.approval.statement)) {
      delete task.metadata.approval;
      if (['ready', 'reviewing_result', 'completed', 'active', 'needs_review', 'finalizing', 'regression_ready'].includes(String(task.metadata.status))) task.metadata.status = 'awaiting_approval';
      taskChanged = true;
      result.invalidatedLegacyApprovals += 1;
    }
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
      if (!scenario.plannedSteps?.length) {
        scenario.plannedSteps = [
          { id: 'open-target', action: '打开目标页面或应用入口', expected: '页面正常加载，可以开始执行场景。' },
          { id: 'execute-scenario', action: `执行场景目标：${scenario.intent}`, expected: typeof scenario.expected.outcome === 'string' ? scenario.expected.outcome : JSON.stringify(scenario.expected) },
          { id: 'verify-result', action: '验证最终可见业务状态', expected: '实际结果与声明的预期结果一致，或记录明确差异。' },
          { id: 'capture-evidence', action: '截取关键结果页面作为证据', expected: '截图保存在对应 Task Run 目录。' },
        ];
        scenario.planningStatus = 'needs_user_decision';
        if (!['running', 'archived'].includes(String(task.metadata.status))) task.metadata.status = 'planning';
        delete task.metadata.approval;
        result.backfilledPlannedSteps += 1; taskChanged = true; schemaBackfillChanged = true;
      }
    }
    if (task.requirements && !task.requirements.requirementTrace?.length) { task.requirements.requirementTrace = task.scenarios.map(scenario => ({ requirementId: scenario.requirementRefs?.[0] ?? `requirement-${scenario.id}`, scenarioIds: [scenario.id], assertionIds: (scenario.visualAssertions ?? []).map(assertion => assertion.id), sourceRefs: scenario.sourceRefs ?? task.requirements?.sourceRefs ?? [], status: 'covered' })); result.backfilledRequirementTrace += task.requirements.requirementTrace.length; taskChanged = true; schemaBackfillChanged = true; }
    const normalizedState = normalizeTaskState(task.metadata.status);
    if (task.metadata.status !== normalizedState) { task.metadata.status = normalizedState; task.updatedAt = now(); taskChanged = true; result.normalizedTaskStates += 1; }
    const currentPlanHash = testPlanHash(task); const legacyPlanHash = legacyWorkflowV2PlanHash(task);
    const canRehash = Boolean(previousApprovedHash && previousApprovedHash !== currentPlanHash && previousApprovedHash === legacyPlanHash && task.metadata.approval);
    if (canRehash && task.metadata.approval) { task.metadata.approval.planHash = currentPlanHash; if (task.testPlan) { task.testPlan.planHash = currentPlanHash; task.testPlan.status = 'approved'; task.testPlan.approvedBy = task.metadata.approval.confirmedBy; task.testPlan.approvedAt = task.metadata.approval.confirmedAt; task.testPlan.updatedAt = now(); } task.updatedAt = now(); taskChanged = true; result.rehashedApprovedPlans += 1; }

    const regressionManifestPaths = listFiles(join(taskDir, 'regression'), path => path.endsWith('.json'));
    const regressionManifests = regressionManifestPaths.map(path => { try { return readJson<Record<string, any>>(path); } catch { return {}; } });
    const candidates = collectLegacyRuns(taskDir);
    const selected = chooseSourceRun(candidates, task, regressionManifests);
    const sourceDirectory = taskSourceRunDirectory(root, task.metadata.moduleId, task.metadata.id);
    if (selected) {
      for (const candidate of candidates.filter(item => item.run.id !== selected.run.id || item.directory !== selected.directory)) {
        const backup = qaPath(root, '.runtime', 'migration-backup', 'source-runs', task.metadata.moduleId, task.metadata.id, candidate.run.id);
        moveDirectory(candidate.directory, backup);
        result.quarantinedLegacySourceRuns += 1;
      }
      if (selected.directory !== sourceDirectory) {
        moveDirectory(selected.directory, sourceDirectory);
        result.migratedSourceRuns += 1;
      }
      const sourceRunPath = taskSourceRunPath(root, task.metadata.moduleId, task.metadata.id);
      const sourceRun = normalizeSourceRun(selected.run);
      if (!sourceRun.planHash && task.metadata.approval && sourceRun.startedAt >= task.metadata.approval.confirmedAt) { sourceRun.planHash = task.metadata.approval.planHash; result.backfilledRunPlanHashes += 1; }
      const legacyReport = join(legacyReportsDir, `${sourceRun.id}.md`);
      const sourceReport = taskSourceRunReportPath(root, task.metadata.moduleId, task.metadata.id);
      if (!existsSync(sourceReport) && existsSync(legacyReport)) { copyThenRemove(legacyReport, sourceReport); result.migratedTaskReports += 1; }
      if (sourceRun.completedAt && existsSync(sourceReport)) {
        ensureRuntimeMarker(sourceReport, sourceRun.id);
        sourceRun.reportPath = 'source-run/report.md';
        sourceRun.reportGeneratedBy = RUNTIME_REPORT_GENERATOR;
        sourceRun.reportGeneratedAt ??= sourceRun.completedAt;
      }
      if (sourceRun.completedAt) {
        try { sourceRun.pythonRegressionEligibility = inspectPythonRegressionEligibility(task, sourceRun); } catch { /* preserve source facts */ }
      }
      writeJsonAtomic(sourceRunPath, sourceRun);
      result.updatedRuns += 1;
      task.sourceRunRef = 'source-run/run.json';
      if (sourceRun.completedAt && existsSync(sourceReport)) task.sourceReportRef = 'source-run/report.md'; else delete task.sourceReportRef;
      if (task.finalization && task.finalization.sourceRunId !== sourceRun.id) delete task.finalization;
      taskChanged = true;
    } else {
      if (task.sourceRunRef !== undefined) { delete task.sourceRunRef; taskChanged = true; }
      if (task.sourceReportRef !== undefined) { delete task.sourceReportRef; taskChanged = true; }
      if (task.finalization) { delete task.finalization; taskChanged = true; }
    }

    for (const name of ['index.json', 'latest.json']) {
      for (const path of [join(runDir, name), join(legacyReportsDir, name)]) if (existsSync(path)) { unlinkSync(path); result.migratedRunIndexes += 1; result.removedLegacyRunIndexes += 1; }
    }
    if (existsSync(runDir)) {
      const remaining = listFiles(runDir, () => true);
      if (remaining.length) {
        const backup = qaPath(root, '.runtime', 'migration-backup', 'source-runs', task.metadata.moduleId, task.metadata.id, '_unparsed-runs');
        moveDirectory(runDir, backup);
        result.quarantinedLegacySourceRuns += 1;
        result.warnings.push(`Unparsed legacy Run assets were preserved at ${backup}.`);
      } else rmSync(runDir, { recursive: true, force: true });
    }

    if (!readTaskEvents(root, task.metadata.moduleId, task.metadata.id).length) { appendTaskEvent(root, { type: 'migration_baseline_created', actor: { type: 'migration', id: 'qa-agent-migrate' }, moduleId: task.metadata.moduleId, taskId: task.metadata.id, toState: normalizedState, reasonCode: 'python_only_regression_baseline', artifactHash: task.metadata.approval?.planHash, idempotencyKey: `migration-baseline:${task.metadata.moduleId}:${task.metadata.id}:python-only`, metadata: { previousStatus: raw.metadata.status, normalizedStatus: normalizedState } }); result.createdTaskEventLogs += 1; }
    if (canRehash && previousApprovedHash) appendTaskEvent(root, { type: 'migration_plan_hash_updated', actor: { type: 'migration', id: 'qa-agent-migrate' }, moduleId: task.metadata.moduleId, taskId: task.metadata.id, fromState: normalizedState, toState: normalizedState, reasonCode: 'deterministic_schema_backfill', artifactHash: currentPlanHash, idempotencyKey: `migration-plan-hash:${task.metadata.moduleId}:${task.metadata.id}:${previousApprovedHash}:${currentPlanHash}`, metadata: { previousPlanHash: previousApprovedHash, currentPlanHash, schemaBackfillChanged } });

    if (taskChanged) { saveTask(root, task); result.updatedTasks += 1; }
    const currentTask = readTask(root, task.metadata.moduleId, task.metadata.id);
    for (const manifestPath of regressionManifestPaths) migratePythonAsset(root, currentTask, manifestPath, false, result);

    if (existsSync(legacyReportsDir)) {
      if (listFiles(legacyReportsDir, () => true).length) {
        const backup = qaPath(root, '.runtime', 'migration-backup', 'source-runs', task.metadata.moduleId, task.metadata.id, '_legacy-reports');
        moveDirectory(legacyReportsDir, backup);
        result.warnings.push(`Unselected legacy Task reports were preserved at ${backup}.`);
      } else rmSync(legacyReportsDir, { recursive: true, force: true });
    }
  }

  for (const draftPath of listFiles(qaPath(root, '.runtime', 'drafts'), path => path.endsWith('/draft.json'))) { const raw = readJson<Record<string, any>>(draftPath); try { const task = readTask(root, raw.moduleId, raw.taskId); migratePythonAsset(root, task, draftPath, true, result); } catch (error) { result.warnings.push(`Could not migrate Python draft ${draftPath}: ${(error as Error).message}`); } }
  for (const path of listFiles(qaPath(root, 'regression-runs'), item => item.endsWith('.json'))) { try { const value = readJson<Record<string, any>>(path); if (value.kind !== 'PythonRegressionBatchRun') { unlinkSync(path); result.removedLegacyRegressionRuns += 1; } } catch { unlinkSync(path); result.removedLegacyRegressionRuns += 1; } }

  const globalReports = qaPath(root, 'reports');
  for (const reportPath of listFiles(globalReports, path => path.endsWith('.md'))) { if (validGlobalReport(root, reportPath)) continue; copyThenRemove(reportPath, qaPath(root, 'orphans', 'reports', relative(globalReports, reportPath))); result.quarantinedOrphanReports += 1; }

  for (const name of ['archive', 'cache', 'evidence', 'runs']) {
    const path = qaPath(root, name);
    if (!existsSync(path)) continue;
    if (listFiles(path, () => true).length) {
      result.warnings.push(`Legacy Runtime directory contains files and was preserved for manual review: ${path}`);
      continue;
    }
    rmSync(path, { recursive: true, force: true });
    result.removedLegacyRuntimeDirectories += 1;
  }
  return result;
}
