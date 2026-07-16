import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { approvalIsCurrent, testPlanHash } from './approval.ts';
import { qaPath, saveTask } from './project.ts';
import { assertSafeId, hasSecrets, listFiles, now, readJson, writeJsonAtomic } from './store.ts';
import type { OperationPlan, OperationStep, TestRun, TestTask } from './types.ts';

export function operationsPath(root: string, moduleId: string, taskId: string): string {
  assertSafeId(moduleId, 'module id'); assertSafeId(taskId, 'task id');
  return qaPath(root, 'modules', moduleId, 'tasks', taskId, 'operations');
}

function operationPath(root: string, task: TestTask, id: string): string {
  assertSafeId(id, 'operation id'); return join(operationsPath(root, task.metadata.moduleId, task.metadata.id), `${id}.json`);
}

export function readOperation(root: string, task: TestTask, id: string): OperationPlan { return readJson<OperationPlan>(operationPath(root, task, id)); }
export function listOperations(root: string, task: TestTask): OperationPlan[] {
  return listFiles(operationsPath(root, task.metadata.moduleId, task.metadata.id), path => path.endsWith('.json')).map(path => readJson<OperationPlan>(path));
}

export function saveOperation(root: string, plan: OperationPlan): void {
  writeJsonAtomic(join(operationsPath(root, plan.moduleId, plan.taskId), `${plan.id}.json`), plan);
}

export function reviewOperation(root: string, task: TestTask, id: string, decision: 'approve' | 'reject'): OperationPlan {
  const plan = readOperation(root, task, id);
  if (decision === 'approve') {
    if (!approvalIsCurrent(task)) throw new Error('The Task plan is not currently approved; confirm the Task before approving an Operation JSON.');
    if (plan.planHash !== testPlanHash(task)) throw new Error('Operation JSON was generated from a different Task plan hash. Regenerate it before approval.');
    plan.status = 'active';
    task.operationPlanRefs ??= []; if (!task.operationPlanRefs.includes(plan.id)) task.operationPlanRefs.push(plan.id); task.updatedAt = now(); saveTask(root, task);
  } else plan.status = 'deprecated';
  plan.updatedAt = now(); saveOperation(root, plan); return plan;
}

export function createOperationCandidate(root: string, task: TestTask, run: TestRun): string[] {
  if (!['passed', 'adapted'].includes(run.status) || !run.steps.some(step => step.source === 'ui' || step.source === 'operation-replay')) return [];
  const scenario = task.scenarios[0]; if (!scenario) return [];
  const id = `${task.metadata.id}-${scenario.id}-op-${run.id.slice(-8)}`.slice(0, 63);
  const steps: OperationStep[] = run.steps.filter(step => step.source === 'ui' || step.source === 'operation-replay').map((step, index) => ({
    id: step.operationStepId ?? `op-step-${index + 1}`, action: step.action, intent: step.detail, preconditions: [],
    expectedState: step.detail, screenshot: 'after-action', visualInspection: step.visualInspection === 'performed' ? 'required' : 'adaptive',
  }));
  if (hasSecrets(steps)) return [];
  const plan: OperationPlan = {
    $schema: '../../../schemas/operation.schema.json', apiVersion: 'qa-agent/v1', kind: 'OperationPlan', id, version: 1, status: 'candidate',
    taskId: task.metadata.id, moduleId: task.metadata.moduleId, scenarioId: scenario.id, platform: run.context.platform, environment: run.context.environment,
    planHash: testPlanHash(task), steps, preconditions: [...task.preconditions, ...scenario.preconditions], cleanup: scenario.cleanup, capabilities: task.capabilities.required,
    sourceRunId: run.id, successfulRuns: 1, createdAt: now(), updatedAt: now(),
  };
  saveOperation(root, plan); return [relative(qaPath(root), join(operationsPath(root, plan.moduleId, plan.taskId), `${id}.json`))];
}

export function approvedOperationForReplay(root: string, task: TestTask, id: string, context: { platform: string; environment: string; device?: string; appVersion?: string }): OperationPlan {
  const plan = readOperation(root, task, id);
  if (plan.status !== 'active') throw new Error(`Operation ${id} is not approved; review it with task operation review --approve.`);
  if (!approvalIsCurrent(task) || plan.planHash !== testPlanHash(task)) throw new Error('Task approval or plan hash changed; return to test-plan confirmation before replay.');
  if (plan.taskId !== task.metadata.id || plan.moduleId !== task.metadata.moduleId) throw new Error('Operation JSON does not belong to this Task.');
  if (plan.platform !== context.platform) throw new Error(`Operation platform ${plan.platform} is incompatible with requested platform ${context.platform}.`);
  if (plan.environment && plan.environment !== context.environment) throw new Error(`Operation environment ${plan.environment} is incompatible with requested environment ${context.environment}.`);
  if (plan.device && context.device && plan.device !== context.device) throw new Error(`Operation device ${plan.device} is incompatible with requested device ${context.device}.`);
  if (plan.appVersion && context.appVersion && plan.appVersion !== context.appVersion) throw new Error(`Operation app version ${plan.appVersion} is incompatible with requested version ${context.appVersion}.`);
  return plan;
}

export function operationSummary(root: string, task: TestTask): unknown[] {
  return listOperations(root, task).map(plan => ({ id: plan.id, version: plan.version, status: plan.status, scenarioId: plan.scenarioId, platform: plan.platform, planHash: plan.planHash, path: relative(qaPath(root), operationPath(root, task, plan.id)) }));
}
