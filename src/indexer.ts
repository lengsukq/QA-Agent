import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { listFiles, now, readJson, withFileLock, writeJsonAtomic } from './store.ts';
import { qaPath } from './project.ts';
import { readTaskEvents, resumeToken, workflowContextHash } from './events.ts';
import { listPythonRegressions } from './python-regression.ts';
import { normalizeTaskState } from './workflow-model.ts';
import type { ProjectMemory, QaModule, RegressionRun, TestRun, TestTask } from './types.ts';
import type { QaSkillManifest } from './built-in-skills.ts';

export function rebuildIndexes(root: string): { modules: number; tasks: number; memories: number; skills: number; runs: number } {
  return withFileLock(qaPath(root, '.locks', 'indexes.lock'), () => rebuildIndexesUnlocked(root));
}

function rebuildIndexesUnlocked(root: string): { modules: number; tasks: number; memories: number; skills: number; runs: number } {
  const timestamp = now();
  const modules = listFiles(qaPath(root, 'modules'), path => basename(path) === 'module.json').map(path => {
    const item = readJson<QaModule>(path);
    const taskFiles = listFiles(join(path, '..', 'tasks'), task => task.endsWith('/task.json'));
    return { id: item.id, name: item.name, description: item.description, riskLevel: item.riskLevel, status: item.status, path: relative(qaPath(root), path), taskCount: taskFiles.length, activeTaskCount: 0, tags: [], updatedAt: item.updatedAt };
  });
  const tasks = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/task\.json$/.test(path)).map(path => {
    const item = readJson<TestTask>(path);
    const scripts = listPythonRegressions(root, item.metadata.moduleId, item.metadata.id);
    const events = readTaskEvents(root, item.metadata.moduleId, item.metadata.id);
    const lastEvent = events.at(-1);
    const taskState = normalizeTaskState(item.metadata.status);
    const workflowPhase = taskState === 'awaiting_approval' ? 'approval' : taskState === 'running' ? 'execution' : taskState === 'reviewing_result' || taskState === 'completed' ? 'result_review' : taskState === 'archived' ? 'archive' : taskState === 'blocked' || taskState === 'paused' ? 'recovery' : taskState === 'draft' || taskState === 'planning' || taskState === 'needs_input' ? 'planning' : 'preflight';
    const validatedIds = scripts.filter(script => script.status === 'validated').map(script => script.id);
    const unverifiedIds = scripts.filter(script => script.status === 'approved_unverified').map(script => script.id);
    const nextActionIds = taskState === 'archived' ? [] : taskState === 'awaiting_approval' ? ['request_test_plan_approval'] : taskState === 'ready' ? ['start_test'] : taskState === 'running' ? ['execute_scenario'] : unverifiedIds.length ? ['run_python_regression'] : taskState === 'reviewing_result' ? [item.metadata.mode === 'quick' ? 'finalize_task' : 'review_runtime_result'] : taskState === 'completed' ? [validatedIds.length ? 'archive_or_continue' : 'review_runtime_result'] : taskState === 'blocked' || taskState === 'paused' ? ['resolve_run_blocker'] : ['continue_planning'];
    const scriptStates = scripts.map(script => [script.id, script.status, script.scriptHash]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const contextHash = workflowContextHash({ taskState, workflowPhase, pythonRegressionStates: scriptStates, lastEventSeq: lastEvent?.seq });
    return { id: item.metadata.id, moduleId: item.metadata.moduleId, name: item.metadata.name, priority: item.metadata.priority, mode: item.metadata.mode, approvalPolicy: item.metadata.approvalPolicy, status: item.metadata.status, taskState, workflowPhase, executionStatus: 'never_run', path: relative(qaPath(root), path), scenarioCount: item.scenarioRefs?.length ?? 0, pythonRegressionCount: scripts.length, pythonRegressionIds: scripts.map(script => script.id), validatedPythonRegressionIds: validatedIds, approvedUnverifiedPythonRegressionIds: unverifiedIds, pythonRegressionRefs: item.pythonRegressionRefs, contextHash, resumeToken: resumeToken(item.metadata.moduleId, item.metadata.id, undefined, lastEvent?.seq), lastEventSeq: lastEvent?.seq ?? 0, blockers: taskState === 'blocked' ? [lastEvent?.reasonCode ?? 'task_blocked'] : [], nextActionIds, staleReasons: scripts.filter(script => script.status === 'stale').map(script => `python-regression:${script.id}`), tags: item.metadata.tags, updatedAt: item.updatedAt };
  });
  const memoryFiles = [...listFiles(qaPath(root, 'modules'), path => /\/memory\/[^/]+\.json$/.test(path) || /\/tasks\/[^/]+\/memory\/[^/]+\.json$/.test(path)), ...listFiles(qaPath(root, 'shared-memory', 'entries'), path => path.endsWith('.json'))];
  const memories = memoryFiles.flatMap(path => {
    const value = readJson<ProjectMemory | ProjectMemory[]>(path);
    return (Array.isArray(value) ? value : [value]).map(item => ({ id: item.id, moduleId: item.moduleId, type: item.type, title: item.title, summary: item.content.slice(0, 180), knowledgeLevel: item.knowledgeLevel, importance: item.importance, status: item.status, path: relative(qaPath(root), path), updatedAt: item.updatedAt }));
  });
  const runs = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/runs\/[^/]+\/run\.json$/.test(path)).map(path => readJson<TestRun>(path));
  const batchRuns = listFiles(qaPath(root, 'regression-runs'), path => path.endsWith('.json')).map(path => readJson<RegressionRun>(path));
  const pythonRunPaths = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\/regression-runs\/[^/]+\/run\.json$/.test(path));
  const skills = listFiles(qaPath(root, 'skills'), path => path.endsWith('.json')).map(path => { const item = readJson<QaSkillManifest>(path); return { name: item.metadata.name, version: item.metadata.version, description: item.metadata.description, lifecycle: item.metadata.lifecycle, path: relative(qaPath(root), path), capabilities: item.requirements.capabilities }; });
  const lastByTask = new Map<string, TestRun>();
  for (const run of runs) { const key = `${run.moduleId}/${run.taskId}`; if (!lastByTask.has(key) || (lastByTask.get(key)?.startedAt ?? '') < run.startedAt) lastByTask.set(key, run); }
  for (const task of tasks) {
    const related = runs.filter(run => run.taskId === task.id && run.moduleId === task.moduleId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const latest = related[0]; const successful = related.find(item => ['passed', 'adapted'].includes(item.status) && Boolean(item.completedAt)); const current = related.find(item => item.status === 'running');
    if (latest) { task.executionStatus = latest.status; Object.assign(task, { latestRunId: latest.id, lastRunId: latest.id, lastRunAt: latest.startedAt, pythonRegressionEligible: latest.pythonRegressionEligibility?.eligible ?? false }); }
    if (successful) Object.assign(task, { lastSuccessfulRunId: successful.id });
    if (current) { const progress = [current.steps.length, current.visualFindings.length, current.cleanupFindings?.length ?? 0, current.evidence.length, current.recoveryAttempts?.length ?? 0, current.screenshots?.length ?? 0].join('-'); Object.assign(task, { currentRunId: current.id, workflowPhase: 'execution', resumeToken: resumeToken(task.moduleId, task.id, current.id, task.lastEventSeq, progress), contextHash: workflowContextHash({ taskState: task.taskState, workflowPhase: 'execution', currentRunId: current.id, progress }), nextActionIds: ['execute_scenario'] }); }
  }
  for (const module of modules) { const related = tasks.filter(task => task.moduleId === module.id); module.activeTaskCount = related.filter(task => !['archived', 'deprecated', 'superseded'].includes(task.taskState)).length; const latest = related.map(task => lastByTask.get(`${task.moduleId}/${task.id}`)).filter((run): run is TestRun => Boolean(run)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]; if (latest) Object.assign(module, { lastRunStatus: latest.status, lastRunAt: latest.startedAt }); }
  for (const [name, entries] of Object.entries({ modules, tasks, memories, skills })) writeJsonAtomic(qaPath(root, 'index', `${name}.json`), { version: 1, updatedAt: timestamp, [name]: entries });
  return { modules: modules.length, tasks: tasks.length, memories: memories.length, skills: skills.length, runs: runs.length + batchRuns.length + pythonRunPaths.length };
}

export function readIndex<T>(root: string, name: 'modules' | 'tasks' | 'memories' | 'skills'): T[] { const path = qaPath(root, 'index', `${name}.json`); return existsSync(path) ? readJson<Record<string, T[]>>(path)[name] ?? [] : []; }
