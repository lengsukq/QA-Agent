import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { approvalIsCurrent, testPlanHash } from './approval.ts';
import { saveTask, taskOperationDirectory, taskDirectory } from './project.ts';
import { assertSafeId, hasSecrets, listFiles, now, readJson, writeJsonAtomic } from './store.ts';
import type { ExecutionSnapshot, OperationAction, OperationPlan, OperationStep, TestRun, TestScenario, TestTask } from './types.ts';

export function operationsPath(root: string, moduleId: string, taskId: string): string {
  assertSafeId(moduleId, 'module id'); assertSafeId(taskId, 'task id');
  return taskOperationDirectory(root, moduleId, taskId);
}

function operationFilePath(root: string, plan: OperationPlan): string {
  return join(operationsPath(root, plan.moduleId, plan.taskId), plan.scenarioId, `v${plan.version}.json`);
}

function operationRef(root: string, plan: OperationPlan): string { return relative(taskDirectory(root, plan.moduleId, plan.taskId), operationFilePath(root, plan)); }

export function readOperation(root: string, task: TestTask, idOrRef: string): OperationPlan {
  if (idOrRef.endsWith('.json')) {
    const direct = join(taskDirectory(root, task.metadata.moduleId, task.metadata.id), idOrRef);
    if (existsSync(direct)) return readJson<OperationPlan>(direct);
  }
  const found = listOperations(root, task).find(item => item.id === idOrRef);
  if (!found) throw new Error(`Operation ${idOrRef} was not found for Task ${task.metadata.id}.`);
  return found;
}
export function listOperations(root: string, task: TestTask): OperationPlan[] {
  return listFiles(operationsPath(root, task.metadata.moduleId, task.metadata.id), path => path.endsWith('.json') && !path.endsWith('/current.json')).map(path => readJson<OperationPlan>(path));
}

export function saveOperation(root: string, plan: OperationPlan): void {
  writeJsonAtomic(operationFilePath(root, plan), plan);
  if (plan.status === 'active') writeJsonAtomic(join(operationsPath(root, plan.moduleId, plan.taskId), plan.scenarioId, 'current.json'), { operationPlanId: plan.id, version: plan.version, ref: operationRef(root, plan), updatedAt: plan.updatedAt });
}

export function reviewOperation(root: string, task: TestTask, id: string, decision: 'approve' | 'reject'): OperationPlan {
  const plan = readOperation(root, task, id);
  if (decision === 'approve') {
    if (!approvalIsCurrent(task)) throw new Error('The Task plan is not currently approved; confirm the Task before approving an OperationPlan.');
    if (plan.planHash !== testPlanHash(task)) throw new Error('OperationPlan was generated from a different Task plan hash. Regenerate it before approval.');
    plan.status = 'active';
    if (plan.supersedes) {
      const old = listOperations(root, task).find(item => item.id === plan.supersedes);
      if (old) { old.status = 'superseded'; old.updatedAt = now(); saveOperation(root, old); }
    }
    task.operationPlanRefs ??= []; const ref = operationRef(root, plan); if (!task.operationPlanRefs.includes(ref)) task.operationPlanRefs.push(ref); task.updatedAt = now(); saveTask(root, task);
  } else plan.status = 'deprecated';
  plan.updatedAt = now(); saveOperation(root, plan); return plan;
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

export function createOperationCandidates(root: string, task: TestTask, run: TestRun): { candidates: string[]; issues: Array<{ scenarioId: string; reasons: string[] }> } {
  if (run.replayStatus === 'replayed') return { candidates: [], issues: [] };
  const candidates: string[] = [];
  const issues: Array<{ scenarioId: string; reasons: string[] }> = [];
  for (const scenario of task.scenarios) {
    const status = scenarioRunStatus(run, scenario.id);
    const scenarioSteps = run.steps.filter(step => step.scenarioId === scenario.id && (step.source === 'ui' || step.source === 'operation-replay'));
    if (!['passed', 'adapted'].includes(status ?? '')) continue;
    if (!scenarioSteps.length) { issues.push({ scenarioId: scenario.id, reasons: ['No replayable UI steps were recorded for this passed scenario.'] }); continue; }
    const existing = listOperations(root, task).filter(item => item.scenarioId === scenario.id).sort((a, b) => b.version - a.version);
    const previous = run.operationPlanId ? existing.find(item => item.id === run.operationPlanId) : existing.find(item => item.status === 'active');
    const qualityIssues = operationCandidateQualityIssues(scenario, run, scenarioSteps, previous);
    if (qualityIssues.length) { issues.push({ scenarioId: scenario.id, reasons: qualityIssues }); continue; }
    const version = existing[0] ? existing[0].version + 1 : 1;
    const id = `${task.metadata.id}-${scenario.id}-op-v${version}-${run.id.slice(-8)}`.slice(0, 63);
    const steps = scenarioSteps.map((step, index) => buildStep(task, scenario, run, step, index, previous?.steps.find(item => item.id === step.operationStepId)));
    const plan: OperationPlan = {
      $schema: '../../../../schemas/operation.schema.json', apiVersion: 'qa-agent/v2', kind: 'OperationPlan', id, version, status: 'candidate',
      taskId: task.metadata.id, moduleId: task.metadata.moduleId, scenarioId: scenario.id, executionSnapshot: run.context,
      planHash: testPlanHash(task), steps, preconditions: [...task.preconditions, ...scenario.preconditions], cleanup: scenario.cleanup, capabilities: task.capabilities.required,
      sourceRunId: run.id, successfulRuns: 1, supersedes: run.replayStatus === 'adapted' && previous?.status === 'active' ? previous.id : undefined,
      adaptationHistory: run.replayStatus === 'adapted' ? [{ runId: run.id, detail: 'Semantic/accessibility locator adaptation preserved the business meaning.', at: now() }] : [], createdAt: now(), updatedAt: now(),
    };
    if (hasSecrets(plan)) { issues.push({ scenarioId: scenario.id, reasons: ['Candidate contains a potential secret; replace raw values with env: or fixture references.'] }); continue; }
    saveOperation(root, plan);
    const ref = relative(taskDirectory(root, plan.moduleId, plan.taskId), operationFilePath(root, plan));
    task.operationPlanRefs ??= [];
    if (!task.operationPlanRefs.includes(ref)) task.operationPlanRefs.push(ref);
    candidates.push(ref);
  }
  return { candidates, issues };
}

export function approvedOperationForReplay(root: string, task: TestTask, id: string, context: ExecutionSnapshot): OperationPlan {
  const plan = readOperation(root, task, id);
  if (plan.status !== 'active') throw new Error(`Operation ${id} is not approved; review it with task operation review --approve.`);
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
  return listOperations(root, task).map(plan => ({ id: plan.id, version: plan.version, status: plan.status, scenarioId: plan.scenarioId, platform: plan.executionSnapshot.platform, planHash: plan.planHash, path: operationRef(root, plan) }));
}
