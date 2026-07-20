import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { approvedOperationForReplay, listOperations, readOperation } from './operations.ts';
import { modulePath, moduleReportDirectory, qaPath, readModule, readTask, saveTask, taskRegressionSuitePath } from './project.ts';
import { listFiles, now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type {
  ExecutionSnapshot,
  ImpactAnalysis,
  RegressionProfile,
  RegressionRun,
  RegressionSelectionPolicy,
  RegressionSuite,
  RegressionSuiteMember,
  TestPriority,
  TestTask,
} from './types.ts';
import { testPlanHash } from './approval.ts';

const priorityOrder: Record<TestPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const profileThreshold: Record<RegressionProfile, TestPriority> = { fast: 'p0', normal: 'p1', full: 'p3' };

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function priorityIncluded(priority: TestPriority, threshold: TestPriority): boolean {
  return priorityOrder[priority] <= priorityOrder[threshold];
}

function taskMembers(root: string, task: TestTask, selectionReason?: string): RegressionSuiteMember[] {
  const priority = task.metadata.priority ?? 'p1';
  const frequency = task.metadata.frequency ?? (priority === 'p0' ? 'every-release' : 'manual');
  const releaseGate = task.metadata.releaseGate ?? priority === 'p0';
  const estimatedDurationMinutes = task.metadata.estimatedDurationMinutes ?? 5;
  const tags = task.metadata.tags ?? [];
  return listOperations(root, task)
    .filter(plan => plan.status === 'active')
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId) || a.version - b.version)
    .map((plan, index) => ({
      taskId: task.metadata.id,
      moduleId: task.metadata.moduleId,
      scenarioId: plan.scenarioId,
      operationPlanId: plan.id,
      operationPlanRef: join('operation-plans', plan.scenarioId, `v${plan.version}.json`),
      operationVersion: plan.version,
      taskPlanHash: testPlanHash(task),
      priority,
      frequency,
      releaseGate,
      estimatedDurationMinutes,
      tags,
      selectionReason,
      order: index,
    }));
}

function memberKey(member: RegressionSuiteMember): string {
  return [
    member.moduleId,
    member.taskId,
    member.scenarioId,
    member.operationPlanId,
    `v${member.operationVersion}`,
    member.taskPlanHash,
    member.priority,
    member.frequency,
    String(member.releaseGate),
  ].join('/');
}

function suiteHashFor(suite: Pick<RegressionSuite,
  'scope' | 'moduleId' | 'moduleIds' | 'taskId' | 'members' | 'selectionPolicy' | 'priorityThreshold' | 'impactedModules'
>): string {
  return hash({
    scope: suite.scope,
    moduleId: suite.moduleId,
    moduleIds: suite.moduleIds,
    taskId: suite.taskId,
    selectionPolicy: suite.selectionPolicy,
    priorityThreshold: suite.priorityThreshold,
    impactedModules: suite.impactedModules ?? [],
    members: suite.members.map(memberKey),
  });
}

function suiteBase(input: {
  id: string;
  scope: RegressionSuite['scope'];
  moduleId: string;
  moduleIds?: string[];
  taskId?: string;
  members: RegressionSuiteMember[];
  name?: string;
  purpose?: string;
  selectionPolicy?: RegressionSelectionPolicy;
  priorityThreshold?: TestPriority;
  impactedModules?: string[];
  selectionReasons?: string[];
  releaseGate?: boolean;
}): RegressionSuite {
  const timestamp = now();
  const moduleIds = [...new Set(input.moduleIds ?? input.members.map(member => member.moduleId))];
  const members = input.members.map((member, order) => ({ ...member, order }));
  const partial = {
    scope: input.scope,
    moduleId: input.moduleId,
    moduleIds,
    taskId: input.taskId,
    members,
    selectionPolicy: input.selectionPolicy ?? 'all-active-operation-plans',
    priorityThreshold: input.priorityThreshold ?? 'p3',
    impactedModules: input.impactedModules,
  };
  return {
    $schema: input.scope === 'task'
      ? '../../../../schemas/regression-suite.schema.json'
      : input.scope === 'module'
        ? '../../schemas/regression-suite.schema.json'
        : './schemas/regression-suite.schema.json',
    apiVersion: 'qa-agent/v2',
    kind: 'RegressionSuite',
    id: input.id,
    version: 1,
    ...partial,
    name: input.name ?? `${input.moduleId} regression`,
    purpose: input.purpose ?? 'Replay approved business flows and revalidate their declared assertions.',
    releaseGate: input.releaseGate ?? members.some(member => member.releaseGate),
    estimatedDurationMinutes: members.reduce((total, member) => total + member.estimatedDurationMinutes, 0),
    selectionReasons: input.selectionReasons,
    failurePolicy: 'continue-independent',
    contextPolicy: 'current-context',
    suiteHash: suiteHashFor(partial),
    status: members.length ? 'active' : 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function currentMembers(root: string, suite: RegressionSuite): RegressionSuiteMember[] {
  if (suite.scope === 'task' && suite.taskId) {
    return taskMembers(root, readTask(root, suite.moduleId, suite.taskId));
  }
  if (suite.scope === 'module') {
    const taskPaths = listFiles(join(modulePath(root, suite.moduleId), 'tasks'), path => path.endsWith('/task.json')).sort();
    return taskPaths
      .flatMap(path => taskMembers(root, readTask(root, suite.moduleId, readJson<TestTask>(path).metadata.id)))
      .filter(member => priorityIncluded(member.priority, suite.priorityThreshold))
      .sort((a, b) => memberKey(a).localeCompare(memberKey(b)))
      .map((member, order) => ({ ...member, order }));
  }

  const selectedTasks = [...new Map(suite.members.map(member => [`${member.moduleId}/${member.taskId}`, member])).values()];
  return selectedTasks
    .flatMap(member => taskMembers(root, readTask(root, member.moduleId, member.taskId), member.selectionReason))
    .sort((a, b) => memberKey(a).localeCompare(memberKey(b)))
    .map((member, order) => ({ ...member, order }));
}

export function syncTaskRegressionSuite(root: string, task: TestTask): RegressionSuite {
  const suite = suiteBase({
    id: `${task.metadata.id}-regression`,
    scope: 'task',
    moduleId: task.metadata.moduleId,
    moduleIds: [task.metadata.moduleId],
    taskId: task.metadata.id,
    members: taskMembers(root, task),
    name: `${task.metadata.name} regression`,
    purpose: `Replay all active OperationPlans for ${task.metadata.name}.`,
  });
  writeJsonAtomic(taskRegressionSuitePath(root, task.metadata.moduleId, task.metadata.id), suite);
  task.regressionSuiteRef = 'regression-suite.json';
  task.updatedAt = now();
  saveTask(root, task);
  return suite;
}

export function readTaskRegressionSuite(root: string, task: TestTask): RegressionSuite {
  const suite = readJson<Partial<RegressionSuite>>(taskRegressionSuitePath(root, task.metadata.moduleId, task.metadata.id));
  if (!suite.name || !suite.purpose || !suite.moduleIds || !suite.priorityThreshold || suite.members?.some(member => !member.priority || !member.frequency)) {
    return syncTaskRegressionSuite(root, task);
  }
  return suite as RegressionSuite;
}

/** Module regression is a live aggregate of active Task OperationPlans, never a second persisted suite. */
export function buildModuleRegressionSuite(root: string, moduleId: string, priorityThreshold: TestPriority = 'p3'): RegressionSuite {
  const module = readModule(root, moduleId);
  const taskPaths = listFiles(join(modulePath(root, moduleId), 'tasks'), path => path.endsWith('/task.json')).sort();
  const members = taskPaths
    .flatMap(path => taskMembers(root, readTask(root, moduleId, readJson<TestTask>(path).metadata.id)))
    .filter(member => priorityIncluded(member.priority, priorityThreshold))
    .sort((a, b) => memberKey(a).localeCompare(memberKey(b)));
  return suiteBase({
    id: `${moduleId}-regression`,
    scope: 'module',
    moduleId: module.id,
    moduleIds: [module.id],
    members,
    name: `${module.name} regression`,
    purpose: `Replay approved ${module.name} flows up to priority ${priorityThreshold}.`,
    selectionPolicy: priorityThreshold === 'p3' ? 'all-active-operation-plans' : 'priority-filtered',
    priorityThreshold,
  });
}

export function buildReleaseRegressionSuite(
  root: string,
  impact: ImpactAnalysis,
  profile: RegressionProfile,
): RegressionSuite {
  const threshold = profileThreshold[profile];
  const impacted = new Set(impact.impactedModules.map(item => item.moduleId));
  const selectedTaskReasons = new Map(impact.selectedTasks.map(item => [`${item.moduleId}/${item.taskId}`, item.reasons]));
  const hasImpact = impacted.size > 0 || selectedTaskReasons.size > 0;
  const taskPaths = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path)).sort();
  const selected: RegressionSuiteMember[] = [];
  const selectionReasons = new Set<string>();

  for (const path of taskPaths) {
    const manifest = readJson<TestTask>(path);
    if (!['ready', 'active'].includes(manifest.metadata.status)) continue;
    const task = readTask(root, manifest.metadata.moduleId, manifest.metadata.id);
    const tags = task.metadata.tags ?? [];
    const goldenPath = tags.includes('golden-path');
    const releaseGate = task.metadata.releaseGate ?? task.metadata.priority === 'p0';
    const everyRelease = task.metadata.frequency === 'every-release';
    const taskImpactReasons = selectedTaskReasons.get(`${task.metadata.moduleId}/${task.metadata.id}`) ?? [];
    const impactedTask = impacted.has(task.metadata.moduleId) || taskImpactReasons.length > 0;
    const allowedPriority = priorityIncluded(task.metadata.priority, threshold);

    let include = profile === 'full';
    const reasons: string[] = [];
    if (profile === 'full') reasons.push('Full profile includes every active approved OperationPlan.');
    if (releaseGate) { include = true; reasons.push('Task is a release gate.'); }
    if (goldenPath) { include = true; reasons.push('Task is tagged golden-path.'); }
    if (everyRelease) { include = true; reasons.push('Task frequency is every-release.'); }
    if (hasImpact && impactedTask && allowedPriority) {
      include = true;
      reasons.push(`Task is selected by impact analysis and is within ${threshold.toUpperCase()} priority.`);
      reasons.push(...taskImpactReasons);
    }
    if (!hasImpact && allowedPriority) {
      include = true;
      reasons.push(`No module impact was resolved; profile fallback includes ${threshold.toUpperCase()} and higher tasks.`);
    }
    if (!include) continue;

    const reason = reasons.join(' ');
    for (const member of taskMembers(root, task, reason)) selected.push(member);
    reasons.forEach(item => selectionReasons.add(item));
  }

  selected.sort((a, b) =>
    Number(b.releaseGate) - Number(a.releaseGate)
    || priorityOrder[a.priority] - priorityOrder[b.priority]
    || a.moduleId.localeCompare(b.moduleId)
    || a.taskId.localeCompare(b.taskId)
    || a.scenarioId.localeCompare(b.scenarioId),
  );

  return suiteBase({
    id: `release-${profile}-${impact.id}`,
    scope: 'release',
    moduleId: 'release',
    moduleIds: [...new Set(selected.map(member => member.moduleId))],
    members: selected,
    name: `${profile[0]!.toUpperCase()}${profile.slice(1)} release regression`,
    purpose: `Validate release gates, golden paths, and impacted business flows using the ${profile} profile.`,
    selectionPolicy: profile === 'full' ? 'all-active-operation-plans' : 'release-gate-plus-impact',
    priorityThreshold: threshold,
    impactedModules: [...impacted],
    selectionReasons: [...selectionReasons],
    releaseGate: true,
  });
}

export function suitePreflight(root: string, suite: RegressionSuite, context: ExecutionSnapshot): string[] {
  const errors: string[] = [];
  const current = currentMembers(root, suite);
  const currentKeys = current.map(memberKey).sort().join('|');
  const suiteKeys = suite.members.map(memberKey).sort().join('|');
  if (currentKeys !== suiteKeys || suite.suiteHash !== suiteHashFor(suite)) {
    errors.push(`RegressionSuite ${suite.id} is stale; rebuild or sync it after reviewing current Task and OperationPlan changes.`);
  }
  if (suite.status !== 'active') errors.push(`RegressionSuite ${suite.id} is not active.`);
  for (const member of suite.members) {
    try {
      const task = readTask(root, member.moduleId, member.taskId);
      const module = readModule(root, member.moduleId);
      if (task.moduleSnapshot && task.moduleSnapshot.moduleRevision !== (module.revision ?? 1)) {
        throw new Error(`Module revision changed from ${task.moduleSnapshot.moduleRevision} to ${module.revision ?? 1}; regenerate requirements and obtain confirmation.`);
      }
      const plan = readOperation(root, task, member.operationPlanId);
      approvedOperationForReplay(root, task, plan.id, { ...context, scenarioId: plan.scenarioId });
      if (member.taskPlanHash !== testPlanHash(task)) {
        errors.push(`Task ${member.taskId} plan hash changed for ${member.scenarioId}; sync and reconfirm before replay.`);
      }
    } catch (error) {
      errors.push(`${member.taskId}/${member.scenarioId}: ${(error as Error).message}`);
    }
  }
  return errors;
}

export function newRegressionRun(suite: RegressionSuite, context: ExecutionSnapshot): RegressionRun {
  return {
    $schema: '../schemas/regression-run.schema.json',
    apiVersion: 'qa-agent/v2',
    kind: 'RegressionRun',
    id: `regression-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    suiteId: suite.id,
    suiteName: suite.name,
    suiteScope: suite.scope,
    suiteVersion: suite.version,
    suiteHash: suite.suiteHash,
    moduleId: suite.moduleId,
    moduleIds: suite.moduleIds,
    priorityThreshold: suite.priorityThreshold,
    releaseGate: suite.releaseGate,
    context,
    status: 'running',
    childRuns: [],
    failurePolicy: 'continue-independent',
    startedAt: now(),
  };
}

export function saveRegressionRun(root: string, run: RegressionRun): void {
  writeJsonAtomic(qaPath(root, 'regression-runs', `${run.id}.json`), run);
}

export function regressionReportPath(root: string, run: RegressionRun): string {
  return run.suiteScope === 'release'
    ? qaPath(root, 'reports', `${run.id}.md`)
    : join(moduleReportDirectory(root, run.moduleId), `${run.id}.md`);
}

export function writeRegressionReport(root: string, run: RegressionRun): string {
  const path = regressionReportPath(root, run);
  const counts = run.childRuns.reduce<Record<string, number>>((result, child) => {
    result[child.status] = (result[child.status] ?? 0) + 1;
    return result;
  }, {});
  const lines = [
    `# ${run.suiteScope === 'release' ? 'Release Regression' : 'Module Regression'}: ${run.suiteName}`,
    '',
    `- Suite: ${run.suiteId} v${run.suiteVersion}`,
    `- Suite hash: ${run.suiteHash}`,
    `- Scope: ${run.suiteScope}`,
    `- Modules: ${run.moduleIds.join(', ') || 'none'}`,
    `- Priority threshold: ${run.priorityThreshold.toUpperCase()}`,
    `- Release gate: ${run.releaseGate ? 'yes' : 'no'}`,
    `- Result: ${run.status.toUpperCase()}`,
    `- Context: ${run.context.environment}/${run.context.platform}/${run.context.role}`,
    `- Summary: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(', ') || 'no child runs'}`,
    '',
    '## Child Runs',
    '',
    ...run.childRuns.map(child =>
      `- ${child.moduleId}/${child.taskId}/${child.scenarioId}: ${child.status.toUpperCase()} — ${child.priority.toUpperCase()}${child.releaseGate ? ' — RELEASE GATE' : ''} — OperationPlan ${child.operationPlanId}${child.reportPath ? ` — ${child.reportPath}` : ''}${child.detail ? ` — ${child.detail}` : ''}`,
    ),
    '',
  ];
  writeTextAtomic(path, `${lines.join('\n')}\n`);
  return path;
}
