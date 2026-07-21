import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { qaPath, readTask, saveTask, taskRunDirectory } from './project.ts';
import { appendTaskEvent, readTaskEvents } from './events.ts';
import { normalizeTaskState } from './workflow-model.ts';
import { testPlanHash } from './approval.ts';
import { syncTaskRegressionSuite } from './regression.ts';
import { saveOperation } from './operations.ts';
import { RUNTIME_REPORT_GENERATOR, runtimeReportMarker } from './report-contract.ts';
import { listFiles, now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type { OperationPlan, RegressionRun, TestRun, TestTask } from './types.ts';

export interface MigrationResult {
  migratedTaskReports: number;
  migratedRunIndexes: number;
  updatedRuns: number;
  updatedTasks: number;
  quarantinedOrphanReports: number;
  migratedOperationPlans: number;
  normalizedTaskStates: number;
  createdTaskEventLogs: number;
  backfilledScenarioAssertions: number;
  backfilledScenarioPlanning: number;
  backfilledRequirementTrace: number;
  rebuiltRegressionSuites: number;
  rehashedApprovedPlans: number;
  backfilledRunPlanHashes: number;
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

function legacyWorkflowV2PlanHash(task: TestTask): string {
  const legacy = structuredClone(task);
  if (legacy.requirements) delete legacy.requirements.requirementTrace;
  for (const scenario of legacy.scenarios) {
    for (const assertion of scenario.visualAssertions ?? []) delete (assertion as Partial<typeof assertion>).importance;
    delete scenario.planningStatus;
    delete scenario.priority;
    delete scenario.requirementRefs;
    delete scenario.sourceRefs;
    delete scenario.deferredReason;
  }
  return testPlanHash(legacy);
}

export function migrateProjectArtifacts(root: string): MigrationResult {
  const result: MigrationResult = {
    migratedTaskReports: 0,
    migratedRunIndexes: 0,
    updatedRuns: 0,
    updatedTasks: 0,
    quarantinedOrphanReports: 0,
    migratedOperationPlans: 0,
    normalizedTaskStates: 0,
    createdTaskEventLogs: 0,
    backfilledScenarioAssertions: 0,
    backfilledScenarioPlanning: 0,
    backfilledRequirementTrace: 0,
    rebuiltRegressionSuites: 0,
    rehashedApprovedPlans: 0,
    backfilledRunPlanHashes: 0,
    warnings: [],
  };

  const taskPaths = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path));
  for (const taskPath of taskPaths) {
    const raw = readJson<TestTask>(taskPath);
    const task = readTask(root, raw.metadata.moduleId, raw.metadata.id);
    const taskDir = dirname(taskPath);
    const legacyReportsDir = join(taskDir, 'reports');
    const runDir = join(taskDir, 'runs');
    const successfulReplayRuns = listFiles(runDir, path => path.endsWith('/run.json'))
      .map(path => readJson<TestRun>(path))
      .filter(run => Boolean(run.operationPlanId) && run.replayStatus !== 'not_replay' && ['passed', 'adapted', 'failed'].includes(run.status) && run.replayStage === 'completed' && Boolean(run.completedAt))
      .sort((left, right) => (left.completedAt ?? left.startedAt).localeCompare(right.completedAt ?? right.startedAt));
    const validationRunByOperation = new Map<string, TestRun>();
    for (const replayRun of successfulReplayRuns) validationRunByOperation.set(replayRun.operationPlanId!, replayRun);
    const previousApprovedHash = task.metadata.approval?.planHash;
    let taskChanged = false;
    let schemaBackfillChanged = false;
    let operationLifecycleChanged = false;
    for (const scenario of task.scenarios) {
      for (const assertion of scenario.visualAssertions ?? []) {
        if (!assertion.importance) {
          assertion.importance = scenario.risk;
          result.backfilledScenarioAssertions += 1;
          taskChanged = true;
          schemaBackfillChanged = true;
        }
      }
      if (!scenario.planningStatus) { scenario.planningStatus = 'applicable'; result.backfilledScenarioPlanning += 1; taskChanged = true; schemaBackfillChanged = true; }
      if (!scenario.priority) { scenario.priority = task.metadata.priority; result.backfilledScenarioPlanning += 1; taskChanged = true; schemaBackfillChanged = true; }
      if (!scenario.requirementRefs?.length) { scenario.requirementRefs = [`requirement-${scenario.id}`]; result.backfilledScenarioPlanning += 1; taskChanged = true; schemaBackfillChanged = true; }
      if (!scenario.sourceRefs) { scenario.sourceRefs = task.requirements?.sourceRefs ?? []; result.backfilledScenarioPlanning += 1; taskChanged = true; schemaBackfillChanged = true; }
    }
    if (task.requirements && !task.requirements.requirementTrace?.length) {
      task.requirements.requirementTrace = task.scenarios.map(scenario => ({
        requirementId: scenario.requirementRefs?.[0] ?? `requirement-${scenario.id}`,
        scenarioIds: [scenario.id],
        assertionIds: (scenario.visualAssertions ?? []).map(assertion => assertion.id),
        sourceRefs: scenario.sourceRefs ?? task.requirements?.sourceRefs ?? [],
        status: 'covered',
      }));
      result.backfilledRequirementTrace += task.requirements.requirementTrace.length;
      taskChanged = true;
      schemaBackfillChanged = true;
    }
    const normalizedState = normalizeTaskState(task.metadata.status);
    if (task.metadata.status !== normalizedState) {
      task.metadata.status = normalizedState;
      task.updatedAt = now();
      taskChanged = true;
      result.normalizedTaskStates += 1;
    }
    const currentPlanHash = testPlanHash(task);
    const legacyPlanHash = legacyWorkflowV2PlanHash(task);
    const canRehashMigrationOnlyApproval = Boolean(
      previousApprovedHash
      && previousApprovedHash !== currentPlanHash
      && previousApprovedHash === legacyPlanHash
      && task.metadata.approval,
    );
    if (canRehashMigrationOnlyApproval && task.metadata.approval) {
      task.metadata.approval.planHash = currentPlanHash;
      if (task.testPlan) {
        task.testPlan.planHash = currentPlanHash;
        task.testPlan.status = 'approved';
        task.testPlan.approvedBy = task.metadata.approval.confirmedBy;
        task.testPlan.approvedAt = task.metadata.approval.confirmedAt;
        task.testPlan.updatedAt = now();
      }
      task.updatedAt = now();
      taskChanged = true;
      result.rehashedApprovedPlans += 1;
    }
    for (const operationPath of listFiles(join(taskDir, 'operation-plans'), path => /\/v\d+\.json$/.test(path))) {
      const rawOperation = readJson<Omit<OperationPlan, 'status'> & { status: string }>(operationPath);
      const previousStatus = rawOperation.status;
      const previousOperationPlanHash = rawOperation.planHash;
      const previousApprovedBy = rawOperation.approvedBy;
      const previousApprovedAt = rawOperation.approvedAt;
      const operation = rawOperation as unknown as OperationPlan;
      if (canRehashMigrationOnlyApproval && previousApprovedHash && operation.planHash === previousApprovedHash) operation.planHash = currentPlanHash;
      const validationRun = validationRunByOperation.get(operation.id);
      if ((previousStatus === 'active' || previousStatus === 'approved_unverified') && (operation.validationStatus === 'passed' || validationRun)) {
        operation.status = 'validated';
        operation.validationStatus = 'passed';
        operation.validatedByRunId ??= validationRun?.id;
        operation.validatedAt ??= validationRun?.completedAt;
      } else if (previousStatus === 'active') operation.status = 'approved_unverified';
      else if (previousStatus === 'deprecated') operation.status = 'rejected';
      if (operation.status === 'approved_unverified' && operation.validationStatus === 'failed') operation.status = 'stale';
      if (operation.status === 'approved_unverified') operation.validationStatus = 'unverified';
      if (['approved_unverified', 'validated'].includes(operation.status) && !operation.approvedBy && task.metadata.approval) {
        operation.approvedBy = task.metadata.approval.confirmedBy;
        operation.approvedAt = task.metadata.approval.confirmedAt;
      }
      if (operation.status !== previousStatus || operation.planHash !== previousOperationPlanHash || (operation.status === 'validated' && rawOperation.validationStatus !== 'passed') || operation.approvedBy !== previousApprovedBy || operation.approvedAt !== previousApprovedAt) {
        operation.updatedAt = now();
        saveOperation(root, operation);
        result.migratedOperationPlans += 1;
        operationLifecycleChanged = true;
      }
    }
    const migratedOperations = listFiles(join(taskDir, 'operation-plans'), path => /\/v\d+\.json$/.test(path)).map(path => readJson<OperationPlan>(path));
    const planHashByOperationId = new Map(migratedOperations.map(operation => [operation.id, operation.planHash]));
    const planHashBySourceRunId = new Map(migratedOperations.map(operation => [operation.sourceRunId, operation.planHash]));
    for (const runPath of listFiles(runDir, path => path.endsWith('/run.json'))) {
      const historicalRun = readJson<TestRun>(runPath);
      if (historicalRun.planHash) continue;
      historicalRun.planHash = (historicalRun.operationPlanId ? planHashByOperationId.get(historicalRun.operationPlanId) : undefined)
        ?? planHashBySourceRunId.get(historicalRun.id)
        ?? (task.metadata.approval && historicalRun.startedAt >= task.metadata.approval.confirmedAt ? task.metadata.approval.planHash : undefined);
      if (historicalRun.planHash) {
        writeJsonAtomic(runPath, historicalRun);
        result.updatedRuns += 1;
        result.backfilledRunPlanHashes += 1;
      } else result.warnings.push(`Could not infer planHash for legacy Run ${historicalRun.id}.`);
    }

    if (!readTaskEvents(root, task.metadata.moduleId, task.metadata.id).length) {
      appendTaskEvent(root, {
        type: 'migration_baseline_created',
        actor: { type: 'migration', id: 'qa-agent-migrate' },
        moduleId: task.metadata.moduleId,
        taskId: task.metadata.id,
        toState: normalizedState,
        reasonCode: 'workflow_v3_baseline',
        artifactHash: task.metadata.approval?.planHash,
        idempotencyKey: `migration-baseline:${task.metadata.moduleId}:${task.metadata.id}:workflow-v3`,
        metadata: { previousStatus: raw.metadata.status, normalizedStatus: normalizedState },
      });
      result.createdTaskEventLogs += 1;
    }
    if (canRehashMigrationOnlyApproval && previousApprovedHash) {
      appendTaskEvent(root, {
        type: 'migration_plan_hash_updated',
        actor: { type: 'migration', id: 'qa-agent-migrate' },
        moduleId: task.metadata.moduleId,
        taskId: task.metadata.id,
        fromState: normalizedState,
        toState: normalizedState,
        reasonCode: 'deterministic_workflow_v3_schema_backfill',
        artifactHash: currentPlanHash,
        idempotencyKey: `migration-plan-hash:${task.metadata.moduleId}:${task.metadata.id}:${previousApprovedHash}:${currentPlanHash}`,
        metadata: { previousPlanHash: previousApprovedHash, currentPlanHash, schemaBackfillChanged },
      });
    }

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
      taskChanged = true;
    }
    if (taskChanged) {
      saveTask(root, task);
      result.updatedTasks += 1;
    }
    if ((operationLifecycleChanged || canRehashMigrationOnlyApproval) && task.regressionSuiteRef) {
      syncTaskRegressionSuite(root, readTask(root, task.metadata.moduleId, task.metadata.id));
      result.rebuiltRegressionSuites += 1;
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
