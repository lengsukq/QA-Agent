import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { listPythonRegressions, readPythonRegression, runPythonRegression } from './python-regression.ts';
import { modulePath, moduleReportDirectory, qaPath, readModule, readTask } from './project.ts';
import { listFiles, now, readJson, writeJsonAtomic, writeTextAtomic } from './store.ts';
import type {
  ImpactAnalysis,
  PythonRegressionBusinessStatus,
  PythonRegressionSelection,
  PythonRegressionSelectionMember,
  RegressionProfile,
  RegressionRun,
  RegressionSelectionPolicy,
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

function taskMembers(root: string, task: TestTask, selectionReason?: string): PythonRegressionSelectionMember[] {
  const priority = task.metadata.priority ?? 'p1';
  const frequency = task.metadata.frequency ?? (priority === 'p0' ? 'every-release' : 'manual');
  const releaseGate = task.metadata.releaseGate ?? priority === 'p0';
  const estimatedDurationMinutes = task.metadata.estimatedDurationMinutes ?? 5;
  const tags = task.metadata.tags ?? [];
  return listPythonRegressions(root, task.metadata.moduleId, task.metadata.id)
    .filter(script => script.status === 'validated' && script.sourcePlanHash === testPlanHash(task))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((script, order) => ({
      taskId: task.metadata.id,
      moduleId: task.metadata.moduleId,
      regressionId: script.id,
      scriptRef: script.scriptRef,
      scriptHash: script.scriptHash,
      sourcePlanHash: script.sourcePlanHash,
      scenarioIds: script.scenarioIds,
      priority,
      frequency,
      releaseGate,
      estimatedDurationMinutes,
      tags,
      selectionReason,
      order,
    }));
}

function memberKey(member: PythonRegressionSelectionMember): string {
  return [member.moduleId, member.taskId, member.regressionId, member.scriptHash, member.sourcePlanHash, member.priority, member.frequency, String(member.releaseGate)].join('/');
}

function selectionHash(input: Pick<PythonRegressionSelection, 'scope' | 'moduleId' | 'moduleIds' | 'taskId' | 'members' | 'selectionPolicy' | 'priorityThreshold' | 'impactedModules' | 'requiredAssetGaps'>): string {
  return hash({
    scope: input.scope,
    moduleId: input.moduleId,
    moduleIds: input.moduleIds,
    taskId: input.taskId,
    selectionPolicy: input.selectionPolicy,
    priorityThreshold: input.priorityThreshold,
    impactedModules: input.impactedModules ?? [],
    requiredAssetGaps: input.requiredAssetGaps ?? [],
    members: input.members.map(memberKey),
  });
}

function selectionBase(input: {
  id: string;
  scope: PythonRegressionSelection['scope'];
  moduleId: string;
  moduleIds?: string[];
  taskId?: string;
  members: PythonRegressionSelectionMember[];
  name?: string;
  purpose?: string;
  selectionPolicy?: RegressionSelectionPolicy;
  priorityThreshold?: TestPriority;
  impactedModules?: string[];
  selectionReasons?: string[];
  releaseGate?: boolean;
  requiredAssetGaps?: PythonRegressionSelection['requiredAssetGaps'];
}): PythonRegressionSelection {
  const generatedAt = now();
  const members = input.members.map((member, order) => ({ ...member, order }));
  const partial = {
    scope: input.scope,
    moduleId: input.moduleId,
    moduleIds: [...new Set(input.moduleIds ?? members.map(member => member.moduleId))],
    taskId: input.taskId,
    members,
    selectionPolicy: input.selectionPolicy ?? 'all-validated-python-regressions' as const,
    priorityThreshold: input.priorityThreshold ?? 'p3' as TestPriority,
    impactedModules: input.impactedModules,
    requiredAssetGaps: input.requiredAssetGaps,
  };
  return {
    apiVersion: 'qa-agent/python-regression-selection/v1',
    kind: 'PythonRegressionSelection',
    id: input.id,
    ...partial,
    name: input.name ?? `${input.moduleId} Python regression`,
    purpose: input.purpose ?? 'Run approved Python business regression scripts and review their Runtime reports.',
    releaseGate: input.releaseGate ?? members.some(member => member.releaseGate),
    estimatedDurationMinutes: members.reduce((total, member) => total + member.estimatedDurationMinutes, 0),
    selectionReasons: input.selectionReasons,
    selectionHash: selectionHash(partial),
    status: members.length ? 'ready' : 'blocked',
    generatedAt,
  };
}

export function buildTaskRegressionSelection(root: string, task: TestTask): PythonRegressionSelection {
  task = readTask(root, task.metadata.moduleId, task.metadata.id);
  return selectionBase({
    id: `${task.metadata.id}-python-regression`,
    scope: 'task',
    moduleId: task.metadata.moduleId,
    moduleIds: [task.metadata.moduleId],
    taskId: task.metadata.id,
    members: taskMembers(root, task),
    name: `${task.metadata.name} Python regression`,
    purpose: `Run all validated Python scripts for ${task.metadata.name}.`,
  });
}

export function buildModuleRegressionSelection(root: string, moduleId: string, priorityThreshold: TestPriority = 'p3'): PythonRegressionSelection {
  const module = readModule(root, moduleId);
  const taskPaths = listFiles(join(modulePath(root, moduleId), 'tasks'), path => path.endsWith('/task.json')).sort();
  const members = taskPaths
    .flatMap(path => taskMembers(root, readTask(root, moduleId, readJson<TestTask>(path).metadata.id)))
    .filter(member => priorityIncluded(member.priority, priorityThreshold))
    .sort((a, b) => memberKey(a).localeCompare(memberKey(b)));
  return selectionBase({
    id: `${moduleId}-python-regression`,
    scope: 'module',
    moduleId: module.id,
    moduleIds: [module.id],
    members,
    name: `${module.name} Python regression`,
    purpose: `Run validated ${module.name} Python scripts up to priority ${priorityThreshold}.`,
    selectionPolicy: priorityThreshold === 'p3' ? 'all-validated-python-regressions' : 'priority-filtered',
    priorityThreshold,
  });
}

export function buildReleaseRegressionSelection(root: string, impact: ImpactAnalysis, profile: RegressionProfile): PythonRegressionSelection {
  const threshold = profileThreshold[profile];
  const impacted = new Set(impact.impactedModules.map(item => item.moduleId));
  const selectedTaskReasons = new Map(impact.selectedTasks.map(item => [`${item.moduleId}/${item.taskId}`, item.reasons]));
  const hasImpact = impacted.size > 0 || selectedTaskReasons.size > 0;
  const taskPaths = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path)).sort();
  const selected: PythonRegressionSelectionMember[] = [];
  const requiredAssetGaps: NonNullable<PythonRegressionSelection['requiredAssetGaps']> = [];
  const selectionReasons = new Set<string>();

  for (const path of taskPaths) {
    const manifest = readJson<TestTask>(path);
    if (!['ready', 'running', 'reviewing_result', 'completed'].includes(manifest.metadata.status)) continue;
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
    if (profile === 'full') reasons.push('Full profile includes every validated Python regression script.');
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
    const members = taskMembers(root, task, reason);
    const assetRequired = releaseGate || goldenPath || everyRelease || (hasImpact && impactedTask && allowedPriority) || (!hasImpact && allowedPriority && profile !== 'full');
    if (!members.length && assetRequired) {
      requiredAssetGaps.push({ moduleId: task.metadata.moduleId, taskId: task.metadata.id, priority: task.metadata.priority, releaseGate, goldenPath, reason: `${reason} No validated Python regression script exists for this required Task.` });
    } else selected.push(...members);
    reasons.forEach(item => selectionReasons.add(item));
  }

  selected.sort((a, b) => Number(b.releaseGate) - Number(a.releaseGate) || priorityOrder[a.priority] - priorityOrder[b.priority] || a.moduleId.localeCompare(b.moduleId) || a.taskId.localeCompare(b.taskId) || a.regressionId.localeCompare(b.regressionId));
  return selectionBase({
    id: `release-${profile}-${impact.id}`,
    scope: 'release',
    moduleId: 'release',
    moduleIds: [...new Set(selected.map(member => member.moduleId))],
    members: selected,
    name: `${profile[0]!.toUpperCase()}${profile.slice(1)} release Python regression`,
    purpose: `Validate release gates, golden paths, and impacted business flows using approved Python scripts and the ${profile} profile.`,
    selectionPolicy: profile === 'full' ? 'all-validated-python-regressions' : 'release-gate-plus-impact',
    priorityThreshold: threshold,
    impactedModules: [...impacted],
    selectionReasons: [...selectionReasons],
    releaseGate: true,
    requiredAssetGaps,
  });
}

export function selectionPreflight(root: string, selection: PythonRegressionSelection): string[] {
  const errors: string[] = [];
  if (selection.status !== 'ready') errors.push(`Regression selection ${selection.id} has no runnable script.`);
  if (selection.selectionHash !== selectionHash(selection)) errors.push(`Regression selection ${selection.id} changed after it was generated.`);
  for (const member of selection.members) {
    try {
      const task = readTask(root, member.moduleId, member.taskId);
      const script = readPythonRegression(root, member.moduleId, member.taskId, member.regressionId);
      if (script.status !== 'validated') throw new Error(`Python regression ${script.id} is ${script.status}, not validated.`);
      if (script.scriptHash !== member.scriptHash) throw new Error(`Python regression ${script.id} hash changed after selection.`);
      if (script.sourcePlanHash !== testPlanHash(task) || member.sourcePlanHash !== testPlanHash(task)) throw new Error(`Task plan changed after Python regression ${script.id} approval.`);
    } catch (error) {
      errors.push(`${member.moduleId}/${member.taskId}/${member.regressionId}: ${(error as Error).message}`);
    }
  }
  return errors;
}

function batchStatus(statuses: PythonRegressionBusinessStatus[], contracts: string[]): PythonRegressionBusinessStatus {
  if (contracts.some(status => status !== 'completed')) return 'blocked';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  return statuses.length ? 'passed' : 'blocked';
}

export function runRegressionSelection(root: string, selection: PythonRegressionSelection, input: { pythonCommand?: string; timeoutMs?: number } = {}): RegressionRun {
  const startedAt = now();
  const run: RegressionRun = {
    apiVersion: 'qa-agent/python-regression-batch-run/v1',
    kind: 'PythonRegressionBatchRun',
    id: `regression-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    selectionId: selection.id,
    selectionName: selection.name,
    selectionScope: selection.scope,
    selectionHash: selection.selectionHash,
    moduleId: selection.moduleId,
    moduleIds: selection.moduleIds,
    priorityThreshold: selection.priorityThreshold,
    releaseGate: selection.releaseGate,
    status: 'blocked',
    childRuns: [],
    failurePolicy: 'continue-independent',
    startedAt,
    completedAt: startedAt,
  };
  const preflight = selectionPreflight(root, selection);
  if (preflight.length) {
    run.childRuns = selection.members.map(member => ({ regressionId: member.regressionId, taskId: member.taskId, moduleId: member.moduleId, scenarioIds: member.scenarioIds, priority: member.priority, releaseGate: member.releaseGate, status: 'blocked', contractStatus: 'blocked', detail: preflight.find(item => item.includes(`${member.moduleId}/${member.taskId}/${member.regressionId}`)) ?? preflight.join(' ') }));
  } else {
    for (const member of selection.members) {
      try {
        const child = runPythonRegression(root, { moduleId: member.moduleId, taskId: member.taskId, scriptId: member.regressionId, pythonCommand: input.pythonCommand, timeoutMs: input.timeoutMs });
        run.childRuns.push({ regressionRunId: child.id, regressionId: member.regressionId, taskId: member.taskId, moduleId: member.moduleId, scenarioIds: member.scenarioIds, priority: member.priority, releaseGate: member.releaseGate, status: child.status, contractStatus: child.contractStatus, reportPath: `modules/${member.moduleId}/tasks/${member.taskId}/regression-runs/${child.id}/${child.reportRef}`, detail: child.conclusion });
      } catch (error) {
        run.childRuns.push({ regressionId: member.regressionId, taskId: member.taskId, moduleId: member.moduleId, scenarioIds: member.scenarioIds, priority: member.priority, releaseGate: member.releaseGate, status: 'blocked', contractStatus: 'failed_to_start', detail: (error as Error).message });
      }
    }
  }
  run.status = batchStatus(run.childRuns.map(child => child.status), run.childRuns.map(child => child.contractStatus));
  run.completedAt = now();
  run.reportPath = run.selectionScope === 'release' ? `reports/${run.id}.md` : `modules/${run.moduleId}/reports/${run.id}.md`;
  saveRegressionRun(root, run);
  writeRegressionReport(root, run);
  return run;
}

export function saveRegressionRun(root: string, run: RegressionRun): void {
  writeJsonAtomic(qaPath(root, 'regression-runs', `${run.id}.json`), run);
}

export function regressionReportPath(root: string, run: RegressionRun): string {
  return run.selectionScope === 'release' ? qaPath(root, 'reports', `${run.id}.md`) : join(moduleReportDirectory(root, run.moduleId), `${run.id}.md`);
}

export function writeRegressionReport(root: string, run: RegressionRun): string {
  const path = regressionReportPath(root, run);
  const counts = run.childRuns.reduce<Record<string, number>>((result, child) => { result[child.status] = (result[child.status] ?? 0) + 1; return result; }, {});
  const lines = [
    `# ${run.selectionScope === 'release' ? 'Release Regression' : 'Python Regression Batch'}: ${run.selectionName}`,
    '',
    `- Selection: ${run.selectionId}`,
    `- Selection hash: ${run.selectionHash}`,
    `- Scope: ${run.selectionScope}`,
    `- Modules: ${run.moduleIds.join(', ') || 'none'}`,
    `- Priority threshold: ${run.priorityThreshold.toUpperCase()}`,
    `- Release gate: ${run.releaseGate ? 'yes' : 'no'}`,
    `- Result: ${run.status.toUpperCase()}`,
    `- Summary: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(', ') || 'no child runs'}`,
    '',
    '## Script Runs',
    '',
    ...run.childRuns.map(child => `- ${child.moduleId}/${child.taskId}/${child.regressionId}: ${child.status.toUpperCase()} — contract ${child.contractStatus}${child.releaseGate ? ' — RELEASE GATE' : ''}${child.reportPath ? ` — ${child.reportPath}` : ''}${child.detail ? ` — ${child.detail}` : ''}`),
    '',
  ];
  writeTextAtomic(path, `${lines.join('\n')}\n`);
  return path;
}
