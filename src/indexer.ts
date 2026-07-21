import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { listFiles, now, readJson, withFileLock, writeJsonAtomic } from './store.ts';
import { qaPath, readProjectPromptBundle } from './project.ts';
import { readTaskEvents, resumeToken, workflowContextHash } from './events.ts';
import { listOperations } from './operations.ts';
import { normalizeTaskState } from './workflow-model.ts';
import type { ProjectMemory, QaModule, RegressionRun, TestRun, TestTask } from './types.ts';
import type { QaSkillManifest } from './built-in-skills.ts';

export function rebuildIndexes(root: string): { modules: number; tasks: number; memories: number; skills: number; runs: number } {
  return withFileLock(qaPath(root, '.locks', 'indexes.lock'), () => rebuildIndexesUnlocked(root));
}

function rebuildIndexesUnlocked(root: string): { modules: number; tasks: number; memories: number; skills: number; runs: number } {
  const timestamp = now();
  const promptBundle = readProjectPromptBundle(root);
  const modules = listFiles(qaPath(root, 'modules'), path => basename(path) === 'module.json').map(path => {
    const item = readJson<QaModule>(path);
    const taskFiles = listFiles(join(path, '..', 'tasks'), task => task.endsWith('/task.json'));
    return { id: item.id, name: item.name, description: item.description, riskLevel: item.riskLevel, status: item.status, path: relative(qaPath(root), path), taskCount: taskFiles.length, activeTaskCount: 0, tags: [], updatedAt: item.updatedAt };
  });
  const tasks = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path)).map(path => {
    const item = readJson<TestTask>(path);
    const taskForOperations = { ...item, scenarios: [] } as TestTask;
    const operations = listOperations(root, taskForOperations);
    const events = readTaskEvents(root, item.metadata.moduleId, item.metadata.id);
    const lastEvent = events.at(-1);
    const taskState = normalizeTaskState(item.metadata.status);
    const workflowPhase = taskState === 'awaiting_approval' ? 'approval' : taskState === 'running' ? 'execution' : taskState === 'reviewing_result' || taskState === 'completed' ? 'result_review' : taskState === 'regression_ready' ? 'regression' : taskState === 'archived' ? 'archive' : taskState === 'blocked' || taskState === 'paused' ? 'recovery' : taskState === 'draft' || taskState === 'planning' || taskState === 'needs_input' ? 'planning' : 'preflight';
    const validatedOperationPlanIds = operations.filter(plan => plan.status === 'validated').map(plan => plan.id);
    const approvedUnverifiedOperationPlanIds = operations.filter(plan => plan.status === 'approved_unverified').map(plan => plan.id);
    const candidateOperationPlanIds = operations.filter(plan => plan.status === 'candidate').map(plan => plan.id);
    const nextActionIds = taskState === 'archived' ? [] : taskState === 'awaiting_approval' ? ['request_test_plan_approval'] : taskState === 'ready' ? ['start_test'] : taskState === 'running' ? ['execute_scenario'] : approvedUnverifiedOperationPlanIds.length ? ['validate_operation_plan'] : candidateOperationPlanIds.length ? ['request_operation_plan_approval'] : taskState === 'regression_ready' || taskState === 'completed' ? ['archive_or_continue'] : taskState === 'blocked' || taskState === 'paused' ? ['resolve_run_blocker'] : ['continue_planning'];
    const operationStates = operations.map(plan => [plan.id, plan.status, plan.planHash]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    const contextHash = workflowContextHash({ taskState, workflowPhase, promptBundleHash: promptBundle.bundleHash, operationStates, lastEventSeq: lastEvent?.seq });
    return { id: item.metadata.id, moduleId: item.metadata.moduleId, name: item.metadata.name, priority: item.metadata.priority, status: item.metadata.status, taskState, workflowPhase, executionStatus: 'never_run', path: relative(qaPath(root), path), scenarioCount: item.scenarioRefs?.length ?? 0, operationCount: operations.length, validatedOperationPlanIds, approvedUnverifiedOperationPlanIds, candidateOperationPlanIds, operationPlanRefs: item.operationPlanRefs, regressionSuiteRef: item.regressionSuiteRef, promptBundleHash: promptBundle.bundleHash, contextHash, resumeToken: resumeToken(item.metadata.moduleId, item.metadata.id, undefined, lastEvent?.seq), lastEventSeq: lastEvent?.seq ?? 0, blockers: taskState === 'blocked' ? [lastEvent?.reasonCode ?? 'task_blocked'] : [], nextActionIds, staleReasons: operations.filter(plan => plan.status === 'stale').map(plan => `operation:${plan.id}`), tags: item.metadata.tags, updatedAt: item.updatedAt };
  });
  const memoryFiles = [
    ...listFiles(qaPath(root, 'modules'), path => /\/memory\/[^/]+\.json$/.test(path) || /\/tasks\/[^/]+\/memory\/[^/]+\.json$/.test(path)),
    ...listFiles(qaPath(root, 'shared-memory', 'entries'), path => path.endsWith('.json')),
  ];
  const memories = memoryFiles.flatMap(path => {
    const value = readJson<ProjectMemory | ProjectMemory[]>(path);
    const entries = Array.isArray(value) ? value : [value];
    return entries.map(item => ({ id: item.id, moduleId: item.moduleId, type: item.type, title: item.title, summary: item.content.slice(0, 180), knowledgeLevel: item.knowledgeLevel, importance: item.importance, status: item.status, path: relative(qaPath(root), path), updatedAt: item.updatedAt }));
  });
  const runs = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/runs\/[^/]+\/run\.json$/.test(path)).map(path => readJson<TestRun>(path));
  const regressionRuns = listFiles(qaPath(root, 'regression-runs'), path => path.endsWith('.json')).map(path => readJson<RegressionRun>(path));
  const skills = listFiles(qaPath(root, 'skills'), path => path.endsWith('.json')).map(path => {
    const item = readJson<QaSkillManifest>(path);
    return { name: item.metadata.name, version: item.metadata.version, description: item.metadata.description, lifecycle: item.metadata.lifecycle, path: relative(qaPath(root), path), capabilities: item.requirements.capabilities };
  });
  const taskKey = (moduleId: string, taskId: string): string => `${moduleId}/${taskId}`;
  const lastByTask = new Map<string, TestRun>();
  for (const run of runs) {
    const key = taskKey(run.moduleId, run.taskId);
    if (!lastByTask.has(key) || (lastByTask.get(key)?.startedAt ?? '') < run.startedAt) lastByTask.set(key, run);
  }
  for (const task of tasks) {
    const relatedRuns = runs.filter(run => run.taskId === task.id && run.moduleId === task.moduleId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const run = relatedRuns[0];
    const successful = relatedRuns.find(item => ['passed', 'adapted'].includes(item.status) && Boolean(item.completedAt));
    const current = relatedRuns.find(item => item.status === 'running');
    if (run) { task.executionStatus = run.status; Object.assign(task, { latestRunId: run.id, lastRunId: run.id, lastRunAt: run.startedAt }); }
    if (successful) Object.assign(task, { lastSuccessfulRunId: successful.id });
    if (current) {
      const progress = [current.steps.length, current.replayCursor ?? 0, current.visualFindings.length, current.cleanupFindings?.length ?? 0, current.evidence.length, current.recoveryAttempts?.length ?? 0, current.screenshots?.length ?? 0, current.replayStage].join('-');
      Object.assign(task, { currentRunId: current.id, workflowPhase: current.replayStatus === 'not_replay' ? 'execution' : 'regression', resumeToken: resumeToken(task.moduleId, task.id, current.id, task.lastEventSeq, progress), contextHash: workflowContextHash({ taskState: task.taskState, workflowPhase: current.replayStatus === 'not_replay' ? 'execution' : 'regression', promptBundleHash: task.promptBundleHash, currentRunId: current.id, progress }) });
      task.nextActionIds = [current.replayStatus === 'not_replay' ? 'execute_scenario' : 'execute_operation_step'];
    }
  }
  for (const module of modules) {
    const related = tasks.filter(task => task.moduleId === module.id);
    module.activeTaskCount = related.filter(task => !['archived', 'deprecated', 'superseded'].includes(task.taskState)).length;
    const latest = related.map(task => lastByTask.get(taskKey(task.moduleId, task.id))).filter((run): run is TestRun => Boolean(run)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (latest) Object.assign(module, { lastRunStatus: latest.status, lastRunAt: latest.startedAt });
  }
  for (const [name, entries] of Object.entries({ modules, tasks, memories, skills })) writeJsonAtomic(qaPath(root, 'index', `${name}.json`), { version: 1, updatedAt: timestamp, [name]: entries });
  return { modules: modules.length, tasks: tasks.length, memories: memories.length, skills: skills.length, runs: runs.length + regressionRuns.length };
}

export function readIndex<T>(root: string, name: 'modules' | 'tasks' | 'memories' | 'skills'): T[] {
  const path = qaPath(root, 'index', `${name}.json`);
  if (!existsSync(path)) return [];
  return (readJson<Record<string, T[]>>(path)[name] ?? []);
}
