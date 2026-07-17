import { createHash, randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { approvedOperationForReplay, listOperations, readOperation } from './operations.ts';
import { modulePath, moduleReportDirectory, qaPath, readModule, readTask, saveTask, taskDirectory, taskRegressionSuitePath } from './project.ts';
import { listFiles, now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type { ExecutionSnapshot, RegressionRun, RegressionSuite, RegressionSuiteMember, TestTask } from './types.ts';
import { testPlanHash } from './approval.ts';

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function taskMembers(root: string, task: TestTask): RegressionSuiteMember[] {
  return listOperations(root, task).filter(plan => plan.status === 'active').sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.version - b.version).map((plan, index) => ({
    taskId: task.metadata.id, moduleId: task.metadata.moduleId, scenarioId: plan.scenarioId, operationPlanId: plan.id,
    operationPlanRef: relative(taskDirectory(root, task.metadata.moduleId, task.metadata.id), join('operation-plans', plan.scenarioId, `v${plan.version}.json`)), operationVersion: plan.version, taskPlanHash: testPlanHash(task), order: index,
  }));
}

function suiteBase(id: string, scope: RegressionSuite['scope'], moduleId: string, members: RegressionSuiteMember[], taskId?: string): RegressionSuite {
  const timestamp = now();
  const suiteHash = suiteHashForMembers(scope, moduleId, taskId, members);
  return { $schema: scope === 'task' ? '../../../../schemas/regression-suite.schema.json' : '../../schemas/regression-suite.schema.json', apiVersion: 'qa-agent/v2', kind: 'RegressionSuite', id, version: 1, scope, moduleId, taskId, members, selectionPolicy: 'all-active-operation-plans', failurePolicy: 'continue-independent', contextPolicy: 'current-context', suiteHash, status: members.length ? 'active' : 'draft', createdAt: timestamp, updatedAt: timestamp };
}

function suiteHashForMembers(scope: RegressionSuite['scope'], moduleId: string, taskId: string | undefined, members: RegressionSuiteMember[]): string {
  return hash({ scope, moduleId, taskId, members: members.map(member => ({ taskId: member.taskId, scenarioId: member.scenarioId, operationPlanId: member.operationPlanId, operationVersion: member.operationVersion, taskPlanHash: member.taskPlanHash })) });
}

function currentMembers(root: string, suite: RegressionSuite): RegressionSuiteMember[] {
  if (suite.scope === 'task' && suite.taskId) return taskMembers(root, readTask(root, suite.moduleId, suite.taskId));
  const taskPaths = listFiles(join(modulePath(root, suite.moduleId), 'tasks'), path => path.endsWith('/task.json')).sort();
  return taskPaths.flatMap(path => taskMembers(root, readTask(root, suite.moduleId, readJson<TestTask>(path).metadata.id))).sort((a, b) => a.taskId.localeCompare(b.taskId) || a.scenarioId.localeCompare(b.scenarioId) || a.operationVersion - b.operationVersion).map((member, index) => ({ ...member, order: index }));
}

export function syncTaskRegressionSuite(root: string, task: TestTask): RegressionSuite {
  const suite = suiteBase(`${task.metadata.id}-regression`, 'task', task.metadata.moduleId, taskMembers(root, task), task.metadata.id);
  writeJsonAtomic(taskRegressionSuitePath(root, task.metadata.moduleId, task.metadata.id), suite);
  task.regressionSuiteRef = 'regression-suite.json'; task.updatedAt = now(); saveTask(root, task);
  return suite;
}

export function readTaskRegressionSuite(root: string, task: TestTask): RegressionSuite {
  return readJson<RegressionSuite>(taskRegressionSuitePath(root, task.metadata.moduleId, task.metadata.id));
}

/** Module regression is a live aggregate of active Task OperationPlans, never a second persisted suite. */
export function buildModuleRegressionSuite(root: string, moduleId: string): RegressionSuite {
  const module = readModule(root, moduleId);
  const taskPaths = listFiles(join(modulePath(root, moduleId), 'tasks'), path => path.endsWith('/task.json')).sort();
  const members = taskPaths.flatMap(path => taskMembers(root, readTask(root, moduleId, readJson<TestTask>(path).metadata.id))).sort((a, b) => a.taskId.localeCompare(b.taskId) || a.scenarioId.localeCompare(b.scenarioId) || a.operationVersion - b.operationVersion).map((member, index) => ({ ...member, order: index }));
  return suiteBase(`${moduleId}-regression`, 'module', module.id, members);
}

export function suitePreflight(root: string, suite: RegressionSuite, context: ExecutionSnapshot): string[] {
  const errors: string[] = [];
  const current = currentMembers(root, suite);
  const currentKeys = current.map(member => `${member.taskId}/${member.scenarioId}/${member.operationPlanId}/v${member.operationVersion}`).join('|');
  const suiteKeys = suite.members.map(member => `${member.taskId}/${member.scenarioId}/${member.operationPlanId}/v${member.operationVersion}`).join('|');
  if (currentKeys !== suiteKeys || suite.suiteHash !== suiteHashForMembers(suite.scope, suite.moduleId, suite.taskId, suite.members)) errors.push(`RegressionSuite ${suite.id} is stale; sync it after reviewing the current Task and OperationPlan changes.`);
  if (suite.status !== 'active') errors.push(`RegressionSuite ${suite.id} is not active.`);
  for (const member of suite.members) {
    try {
      const task = readTask(root, member.moduleId, member.taskId);
      const module = readModule(root, member.moduleId);
      if (task.moduleSnapshot && task.moduleSnapshot.moduleRevision !== (module.revision ?? 1)) throw new Error(`Module revision changed from ${task.moduleSnapshot.moduleRevision} to ${module.revision ?? 1}; regenerate requirements and obtain confirmation.`);
      const plan = readOperation(root, task, member.operationPlanId);
      approvedOperationForReplay(root, task, plan.id, { ...context, scenarioId: plan.scenarioId });
      if (member.taskPlanHash !== testPlanHash(task)) errors.push(`Task ${member.taskId} plan hash changed for ${member.scenarioId}; sync and reconfirm before replay.`);
    } catch (error) { errors.push(`${member.taskId}/${member.scenarioId}: ${(error as Error).message}`); }
  }
  return errors;
}

export function newRegressionRun(suite: RegressionSuite, context: ExecutionSnapshot): RegressionRun {
  return { $schema: '../schemas/regression-run.schema.json', apiVersion: 'qa-agent/v2', kind: 'RegressionRun', id: `regression-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`, suiteId: suite.id, suiteVersion: suite.version, suiteHash: suite.suiteHash, moduleId: suite.moduleId, context, status: 'running', childRuns: [], failurePolicy: 'continue-independent', startedAt: now() };
}

export function saveRegressionRun(root: string, run: RegressionRun): void {
  writeJsonAtomic(qaPath(root, 'regression-runs', `${run.id}.json`), run);
}

export function writeRegressionReport(root: string, run: RegressionRun): string {
  const path = join(moduleReportDirectory(root, run.moduleId), `${run.id}.md`);
  const lines = [`# Module Regression: ${run.moduleId}`, '', `- Suite: ${run.suiteId} v${run.suiteVersion}`, `- Suite hash: ${run.suiteHash}`, `- Result: ${run.status.toUpperCase()}`, `- Context: ${run.context.environment}/${run.context.platform}/${run.context.role}`, '', '## Child Runs', '', ...run.childRuns.map(child => `- ${child.taskId}/${child.scenarioId}: ${child.status.toUpperCase()} — OperationPlan ${child.operationPlanId}${child.reportPath ? ` — ${child.reportPath}` : ''}${child.detail ? ` — ${child.detail}` : ''}`), ''];
  writeTextAtomic(path, `${lines.join('\n')}\n`); return path;
}
