import { existsSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { approvalIsCurrent, assertHumanApprover, testPlanHash } from './approval.ts';
import { readTask, saveTask, taskOperationDirectory, taskDirectory } from './project.ts';
import { assertSafeId, hasSecrets, listFiles, now, readJson, writeJsonAtomic } from './store.ts';
import { appendTaskEvent } from './events.ts';
import type { ExecutionSnapshot, OperationAction, OperationPlan, OperationStep, TestRun, TestScenario, TestTask } from './types.ts';

export function operationsPath(root: string, moduleId: string, taskId: string): string {
  assertSafeId(moduleId, 'module id'); assertSafeId(taskId, 'task id');
  return taskOperationDirectory(root, moduleId, taskId);
}

function operationFilePath(root: string, plan: OperationPlan): string {
  return join(operationsPath(root, plan.moduleId, plan.taskId), plan.scenarioId, `v${plan.version}.json`);
}

function operationRef(root: string, plan: OperationPlan): string { return relative(taskDirectory(root, plan.moduleId, plan.taskId), operationFilePath(root, plan)); }

function currentOperationPath(root: string, moduleId: string, taskId: string, scenarioId: string): string {
  return join(operationsPath(root, moduleId, taskId), scenarioId, 'current.json');
}

function listOperationsByIdentity(root: string, moduleId: string, taskId: string): OperationPlan[] {
  return listFiles(operationsPath(root, moduleId, taskId), path => path.endsWith('.json') && !path.endsWith('/current.json'))
    .map(path => normalizeOperation(readJson<Omit<OperationPlan, 'status'> & { status: string }>(path)));
}

function refreshCurrentOperationPointer(root: string, plan: OperationPlan): void {
  const eligible = listOperationsByIdentity(root, plan.moduleId, plan.taskId)
    .filter(item => item.scenarioId === plan.scenarioId && ['approved_unverified', 'validated'].includes(item.status))
    .sort((left, right) => right.version - left.version);
  const path = currentOperationPath(root, plan.moduleId, plan.taskId, plan.scenarioId);
  const current = eligible[0];
  if (!current) { rmSync(path, { force: true }); return; }
  writeJsonAtomic(path, { operationPlanId: current.id, version: current.version, ref: operationRef(root, current), updatedAt: current.updatedAt });
}

function resolveOperationRef(root: string, task: TestTask, ref: string): string {
  const base = resolve(taskDirectory(root, task.metadata.moduleId, task.metadata.id));
  const path = resolve(base, ref);
  if (path !== base && !path.startsWith(`${base}${sep}`)) throw new Error(`Operation reference escapes Task directory: ${ref}.`);
  return path;
}

function normalizeOperation(raw: Omit<OperationPlan, 'status'> & { status: string }): OperationPlan {
  const legacyStatus = raw.status;
  const plan = raw as unknown as OperationPlan;
  if (legacyStatus === 'active') plan.status = plan.validationStatus === 'passed' ? 'validated' : 'approved_unverified';
  else if (legacyStatus === 'deprecated') plan.status = 'rejected';
  if (plan.status === 'approved_unverified' && plan.validationStatus === 'failed') plan.status = 'stale';
  if (plan.status === 'validated') plan.validationStatus = 'passed';
  if (plan.status === 'approved_unverified') plan.validationStatus = 'unverified';
  return plan;
}

export function readOperation(root: string, task: TestTask, idOrRef: string): OperationPlan {
  if (idOrRef.endsWith('.json')) {
    const direct = resolveOperationRef(root, task, idOrRef);
    if (existsSync(direct)) {
      const plan = normalizeOperation(readJson<Omit<OperationPlan, 'status'> & { status: string }>(direct));
      if (plan.kind !== 'OperationPlan' || plan.taskId !== task.metadata.id || plan.moduleId !== task.metadata.moduleId) throw new Error(`Operation reference does not belong to Task ${task.metadata.id}.`);
      return plan;
    }
  }
  const found = listOperations(root, task).find(item => item.id === idOrRef);
  if (!found) throw new Error(`Operation ${idOrRef} was not found for Task ${task.metadata.id}.`);
  return found;
}
export function listOperations(root: string, task: TestTask): OperationPlan[] {
  return listOperationsByIdentity(root, task.metadata.moduleId, task.metadata.id);
}

export function saveOperation(root: string, plan: OperationPlan): void {
  writeJsonAtomic(operationFilePath(root, plan), plan);
  refreshCurrentOperationPointer(root, plan);
}

export interface OperationValidationResult {
  plan: OperationPlan;
  contractValidated: boolean;
  lifecycleChanged: boolean;
}

export function recordOperationValidation(root: string, task: TestTask, run: TestRun): OperationValidationResult | undefined {
  if (!run.operationPlanId || run.replayStatus === 'not_replay') return undefined;
  const plan = readOperation(root, task, run.operationPlanId);
  const previousStatus = plan.status;
  const previousValidationRunId = plan.validatedByRunId;
  const contractValidated = ['passed', 'adapted', 'failed'].includes(run.status)
    && run.replayStage === 'completed'
    && (run.replayCursor ?? 0) >= plan.steps.length;
  if (contractValidated) {
    plan.status = 'validated';
    plan.validationStatus = 'passed';
    plan.validatedByRunId = run.id;
    plan.validatedAt = run.completedAt ?? now();
    plan.updatedAt = now();
    if (plan.supersedes) {
      const old = listOperations(root, task).find(item => item.id === plan.supersedes);
      if (old && old.status !== 'superseded') { old.status = 'superseded'; old.updatedAt = now(); saveOperation(root, old); }
    }
    saveOperation(root, plan);
  }
  appendTaskEvent(root, {
    type: contractValidated ? 'operation_plan_validated' : 'operation_validation_incomplete',
    actor: { type: 'runtime', id: 'qa-agent-runtime' },
    moduleId: task.metadata.moduleId,
    taskId: task.metadata.id,
    reasonCode: contractValidated ? 'replay_contract_executed' : 'replay_contract_not_completed',
    artifactHash: plan.planHash,
    idempotencyKey: `operation-validation:${plan.id}:${run.id}:${run.status}:${contractValidated}`,
    metadata: { operationPlanId: plan.id, runId: run.id, businessStatus: run.status, replayCursor: run.replayCursor, operationStepCount: plan.steps.length },
  });
  return { plan, contractValidated, lifecycleChanged: previousStatus !== plan.status || previousValidationRunId !== plan.validatedByRunId };
}

export function markOperationsStaleForPlanHash(root: string, task: TestTask, currentPlanHash: string): string[] {
  const stale: string[] = [];
  for (const plan of listOperations(root, task)) {
    if (plan.planHash === currentPlanHash || !['candidate', 'approved_unverified', 'validated'].includes(plan.status)) continue;
    const previousStatus = plan.status;
    plan.status = 'stale';
    plan.validationStatus = 'stale';
    plan.updatedAt = now();
    saveOperation(root, plan);
    appendTaskEvent(root, {
      type: 'operation_plan_stale',
      actor: { type: 'runtime', id: 'qa-agent-runtime' },
      moduleId: task.metadata.moduleId,
      taskId: task.metadata.id,
      reasonCode: 'test_plan_hash_changed',
      artifactHash: currentPlanHash,
      idempotencyKey: `operation-stale:${plan.id}:${currentPlanHash}`,
      metadata: { operationPlanId: plan.id, previousStatus, previousPlanHash: plan.planHash, currentPlanHash },
    });
    stale.push(plan.id);
  }
  return stale;
}

export function reviewOperation(root: string, task: TestTask, id: string, decision: 'approve' | 'reject', reviewedBy: string): OperationPlan {
  assertHumanApprover(reviewedBy);
  task = readTask(root, task.metadata.moduleId, task.metadata.id);
  const plan = readOperation(root, task, id);
  if (decision === 'approve') {
    if (!approvalIsCurrent(task)) throw new Error('The Task plan is not currently approved; confirm the Task before approving an OperationPlan.');
    if (plan.planHash !== testPlanHash(task)) throw new Error('OperationPlan was generated from a different Task plan hash. Regenerate it before approval.');
    if (plan.status === 'approved_unverified' && plan.approvedBy === reviewedBy) {
      task.operationPlanRefs ??= [];
      const existingRef = operationRef(root, plan);
      if (!task.operationPlanRefs.includes(existingRef)) { task.operationPlanRefs.push(existingRef); task.updatedAt = now(); saveTask(root, task); }
      saveOperation(root, plan);
      return plan;
    }
    if (plan.status !== 'candidate') throw new Error(`OperationPlan ${plan.id} is ${plan.status}; only candidate plans can be approved.`);
    plan.status = 'approved_unverified';
    plan.validationStatus = 'unverified';
    plan.approvedBy = reviewedBy;
    plan.approvedAt = now();
    task.operationPlanRefs ??= [];
    const ref = operationRef(root, plan);
    if (!task.operationPlanRefs.includes(ref)) task.operationPlanRefs.push(ref);
    task.updatedAt = now();
    saveTask(root, task);
  } else {
    if (plan.status === 'rejected' && plan.rejectedBy === reviewedBy) { saveOperation(root, plan); return plan; }
    if (!['candidate', 'approved_unverified'].includes(plan.status)) throw new Error(`OperationPlan ${plan.id} is ${plan.status}; it cannot be rejected in this state.`);
    plan.status = 'rejected';
    plan.validationStatus = 'failed';
    plan.rejectedBy = reviewedBy;
    plan.rejectedAt = now();
  }
  plan.updatedAt = now();
  saveOperation(root, plan);
  appendTaskEvent(root, {
    type: decision === 'approve' ? 'operation_plan_approved' : 'operation_plan_rejected',
    actor: { type: 'human', id: reviewedBy },
    moduleId: task.metadata.moduleId,
    taskId: task.metadata.id,
    reasonCode: decision === 'approve' ? 'explicit_operation_promotion_approval' : 'explicit_operation_rejection',
    artifactHash: plan.planHash,
    idempotencyKey: `operation-review:${plan.id}:${decision}:${reviewedBy}`,
    metadata: { operationPlanId: plan.id, status: plan.status },
  });
  return plan;
}

const operationActions = new Set<OperationAction>(['launch', 'navigate', 'click', 'input', 'fill', 'swipe', 'back', 'wait', 'assert', 'screenshot', 'reset', 'restart-app']);

function scenarioRunStatus(run: TestRun, scenarioId: string): string | undefined { return run.scenarioResults.find(item => item.scenarioId === scenarioId)?.status; }

function buildStep(task: TestTask, scenario: TestScenario, run: TestRun, step: TestRun['steps'][number], index: number, previousStep?: OperationStep): OperationStep {
  const action = step.operationAction ?? previousStep?.action ?? (step.action.toLowerCase().includes('tap') || step.action.toLowerCase().includes('click') ? 'click' : step.action.toLowerCase().includes('input') || step.action.toLowerCase().includes('fill') ? 'input' : step.action.toLowerCase().includes('wait') ? 'wait' : step.action.toLowerCase().includes('back') ? 'back' : step.action.toLowerCase().includes('launch') ? 'launch' : 'assert') as OperationAction;
  if (!operationActions.has(action)) throw new Error(`Unsupported operation action generated from step ${step.id}: ${action}`);
  const effectiveLocator = step.actualLocator ?? step.locator ?? previousStep?.locator;
  return {
    id: step.operationStepId ?? `op-step-${index + 1}`, scenarioId: scenario.id, action, intent: step.detail, preconditions: [...scenario.preconditions],
    locator: effectiveLocator, fallbackLocators: effectiveLocator?.fallbacks ?? step.locator?.fallbacks ?? previousStep?.fallbackLocators, inputRefs: step.inputRefs ?? previousStep?.inputRefs,
    expectedState: step.expectedState ?? step.actualState ?? previousStep?.expectedState ?? step.detail, assertionRefs: scenario.visualAssertions?.map(item => item.id),
    screenshotPolicy: 'after-action', visualInspectionPolicy: step.visualInspection === 'performed' ? 'required' : 'adaptive',
    safetyAction: step.safetyAction, checkpoint: Boolean(step.operationStepId?.includes('checkpoint')), executionMode: step.executionMode,
  };
}

function operationCandidateQualityIssues(scenario: TestScenario, run: TestRun, scenarioSteps: TestRun['steps'], previous?: OperationPlan): string[] {
  const reasons: string[] = [];
  const targetActions = new Set<OperationAction>(['navigate', 'click', 'input', 'fill']);
  for (const step of scenarioSteps) {
    const previousStep = previous?.steps.find(item => item.id === step.operationStepId);
    if (step.executionMode === 'user-assisted') reasons.push(`${step.id}: user-assisted execution is valid evidence but is not fully automated replay.`);
    if (step.executionMode === 'system-component-blocked') reasons.push(`${step.id}: system component was blocked and cannot be replayed automatically.`);
    const action = step.operationAction ?? previousStep?.action;
    if (!action) reasons.push(`${step.id}: operationAction is missing; replay actions must be explicit.`);
    if (action && targetActions.has(action) && !(step.actualLocator ?? step.locator ?? previousStep?.locator)) reasons.push(`${step.id}: ${action} requires a planned or actual locator.`);
    if ((action === 'input' || action === 'fill') && !Object.keys(step.inputRefs ?? previousStep?.inputRefs ?? {}).length) reasons.push(`${step.id}: ${action} requires structured inputRefs instead of values embedded only in detail text.`);
    if (!step.screenshotPath) reasons.push(`${step.id}: replayable UI steps require screenshot evidence.`);
  }
  for (const assertion of scenario.visualAssertions ?? []) {
    const finding = run.visualFindings.find(item => item.scenarioId === scenario.id && item.assertionId === assertion.id);
    if (!finding || !['passed', 'adapted'].includes(finding.status) || !finding.screenshotPath) reasons.push(`Assertion ${assertion.id} needs a passed or adapted run observe result with screenshot evidence.`);
  }
  return [...new Set(reasons)];
}

export function createOperationCandidates(root: string, task: TestTask, run: TestRun, options: { scenarioId?: string } = {}): { candidates: string[]; issues: Array<{ scenarioId: string; reasons: string[] }> } {
  if (run.replayStatus === 'replayed') return { candidates: [], issues: [] };
  const candidates: string[] = [];
  const issues: Array<{ scenarioId: string; reasons: string[] }> = [];
  for (const scenario of task.scenarios) {
    if (options.scenarioId && scenario.id !== options.scenarioId) continue;
    const status = scenarioRunStatus(run, scenario.id);
    const scenarioSteps = run.steps.filter(step => step.scenarioId === scenario.id && (step.source === 'ui' || step.source === 'operation-replay'));
    if (!['passed', 'adapted'].includes(status ?? '')) continue;
    if (!scenarioSteps.length) { issues.push({ scenarioId: scenario.id, reasons: ['No replayable UI steps were recorded for this passed scenario.'] }); continue; }
    const existing = listOperations(root, task).filter(item => item.scenarioId === scenario.id).sort((a, b) => b.version - a.version);
    const previous = run.operationPlanId ? existing.find(item => item.id === run.operationPlanId) : existing.find(item => ['validated', 'approved_unverified'].includes(item.status));
    const qualityIssues = operationCandidateQualityIssues(scenario, run, scenarioSteps, previous);
    if (qualityIssues.length) { issues.push({ scenarioId: scenario.id, reasons: qualityIssues }); continue; }
    const version = existing[0] ? existing[0].version + 1 : 1;
    const id = `${task.metadata.id}-${scenario.id}-op-v${version}-${run.id.slice(-8)}`.slice(0, 63);
    const steps = scenarioSteps.map((step, index) => buildStep(task, scenario, run, step, index, previous?.steps.find(item => item.id === step.operationStepId)));
    const plan: OperationPlan = {
      $schema: '../../../../schemas/operation.schema.json', apiVersion: 'qa-agent/v2', kind: 'OperationPlan', id, version, status: 'candidate',
      validationStatus: 'unverified',
      taskId: task.metadata.id, moduleId: task.metadata.moduleId, scenarioId: scenario.id, executionSnapshot: run.context,
      planHash: testPlanHash(task), steps, preconditions: [...task.preconditions, ...scenario.preconditions], cleanup: scenario.cleanup, capabilities: task.capabilities.required,
      sourceRunId: run.id, successfulRuns: 1, supersedes: previous?.id,
      checkpoints: (scenario.visualAssertions ?? []).map(assertion => ({ id: assertion.id, description: assertion.expected, screenshotRequired: true, reportVisible: true })),
      adaptationHistory: run.replayStatus === 'adapted' ? [{ runId: run.id, detail: 'Semantic/accessibility locator adaptation preserved the business meaning.', at: now() }] : [], createdAt: now(), updatedAt: now(),
    };
    if (hasSecrets(plan)) { issues.push({ scenarioId: scenario.id, reasons: ['Candidate contains a potential secret; replace raw values with env: or fixture references.'] }); continue; }
    saveOperation(root, plan);
    appendTaskEvent(root, { type: 'operation_candidate_generated', actor: { type: 'runtime', id: 'qa-agent-runtime' }, moduleId: task.metadata.moduleId, taskId: task.metadata.id, reasonCode: 'successful_explore_materialized_replay_candidate', artifactHash: plan.planHash, idempotencyKey: `operation-candidate:${plan.id}`, metadata: { operationPlanId: plan.id, scenarioId: plan.scenarioId, sourceRunId: run.id } });
    const ref = relative(taskDirectory(root, plan.moduleId, plan.taskId), operationFilePath(root, plan));
    task.operationPlanRefs ??= [];
    if (!task.operationPlanRefs.includes(ref)) task.operationPlanRefs.push(ref);
    candidates.push(ref);
  }
  return { candidates, issues };
}

export function approvedOperationForReplay(root: string, task: TestTask, id: string, context: ExecutionSnapshot): OperationPlan {
  const plan = readOperation(root, task, id);
  if (!['approved_unverified', 'validated'].includes(plan.status)) throw new Error(`Operation ${id} is ${plan.status}; approve a candidate before replay.`);
  if (!approvalIsCurrent(task) || plan.planHash !== testPlanHash(task)) throw new Error('Task approval or plan hash changed; return to test-plan confirmation before replay.');
  if (plan.taskId !== task.metadata.id || plan.moduleId !== task.metadata.moduleId) throw new Error('OperationPlan does not belong to this Task.');
  if (plan.scenarioId !== context.scenarioId && context.scenarioId) throw new Error(`Operation scenario ${plan.scenarioId} is incompatible with requested scenario ${context.scenarioId}.`);
  const expected = plan.executionSnapshot;
  const compare = (label: string, expectedValue: string | undefined, actualValue: string | undefined): void => { if (expectedValue && expectedValue !== actualValue) throw new Error(`Operation ${label} ${expectedValue} is incompatible with current ${actualValue ?? 'unknown'}.`); };
  compare('platform', expected.platform, context.platform); compare('environment', expected.environment, context.environment); compare('role', expected.role, context.role);
  compare('device', expected.device, context.device); compare('device model', expected.deviceModel, context.deviceModel); compare('OS version', expected.osVersion, context.osVersion); compare('app version', expected.appVersion, context.appVersion); compare('Web build', expected.webBuild, context.webBuild); compare('test data', expected.testDataFingerprint, context.testDataFingerprint);
  if (context.permissionSnapshot.status !== 'verified') throw new Error('Required host permissions are not attested as verified; refresh the host capability snapshot before replay.');
  const capabilitiesSatisfied = plan.capabilities.every(capability => context.mcpSnapshot.some(item => item.status === 'available' && item.permissionStatus === 'verified' && item.capabilities.includes(capability)));
  if (!capabilitiesSatisfied) throw new Error('Required host capability or permission attestation is incomplete; refresh the host capability snapshot before replay.');
  return plan;
}

export function operationSummary(root: string, task: TestTask): unknown[] {
  return listOperations(root, task).map(plan => ({ id: plan.id, version: plan.version, status: plan.status, validationStatus: plan.validationStatus ?? (plan.status === 'validated' ? 'passed' : 'unverified'), validatedByRunId: plan.validatedByRunId, scenarioId: plan.scenarioId, platform: plan.executionSnapshot.platform, planHash: plan.planHash, path: operationRef(root, plan) }));
}
