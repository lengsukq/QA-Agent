import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { listFiles, now, readJson, withFileLock, writeJsonAtomic } from './store.ts';
import { qaPath } from './project.ts';
import type { ProjectMemory, QaModule, TestRun, TestTask } from './types.ts';
import type { QaSkillManifest } from './built-in-skills.ts';

export function rebuildIndexes(root: string): { modules: number; tasks: number; memories: number; skills: number; runs: number } {
  return withFileLock(qaPath(root, '.locks', 'indexes.lock'), () => rebuildIndexesUnlocked(root));
}

function rebuildIndexesUnlocked(root: string): { modules: number; tasks: number; memories: number; skills: number; runs: number } {
  const timestamp = now();
  const modules = listFiles(qaPath(root, 'modules'), path => basename(path) === 'module.json').map(path => {
    const item = readJson<QaModule>(path);
    const taskFiles = listFiles(join(path, '..', 'tasks'), task => task.endsWith('.json'));
    return { id: item.id, name: item.name, description: item.description, riskLevel: item.riskLevel, status: item.status, path: relative(qaPath(root), path), taskCount: taskFiles.length, activeTaskCount: 0, tags: [], updatedAt: item.updatedAt };
  });
  const tasks = listFiles(qaPath(root, 'modules'), path => /\/tasks\/[^/]+\.json$/.test(path)).map(path => {
    const item = readJson<TestTask>(path);
    return { id: item.metadata.id, moduleId: item.metadata.moduleId, name: item.metadata.name, priority: item.metadata.priority, status: item.metadata.status, executionStatus: 'never_run', path: relative(qaPath(root), path), scenarioCount: item.scenarios.length, tags: item.metadata.tags, updatedAt: item.updatedAt };
  });
  const memoryFiles = [
    ...listFiles(qaPath(root, 'modules'), path => /\/memory\/[^/]+\.json$/.test(path)),
    ...listFiles(qaPath(root, 'shared-memory', 'entries'), path => path.endsWith('.json')),
  ];
  const memories = memoryFiles.flatMap(path => {
    const value = readJson<ProjectMemory | ProjectMemory[]>(path);
    const entries = Array.isArray(value) ? value : [value];
    return entries.map(item => ({ id: item.id, moduleId: item.moduleId, type: item.type, title: item.title, summary: item.content.slice(0, 180), knowledgeLevel: item.knowledgeLevel, importance: item.importance, status: item.status, path: relative(qaPath(root), path), updatedAt: item.updatedAt }));
  });
  const runs = listFiles(qaPath(root, 'runs'), path => path.endsWith('.json')).map(path => readJson<TestRun>(path));
  const skills = listFiles(qaPath(root, 'skills'), path => path.endsWith('.json')).map(path => {
    const item = readJson<QaSkillManifest>(path);
    return { name: item.metadata.name, version: item.metadata.version, description: item.metadata.description, lifecycle: item.metadata.lifecycle, path: relative(qaPath(root), path), capabilities: item.requirements.capabilities };
  });
  const lastByTask = new Map<string, TestRun>();
  for (const run of runs) if (!lastByTask.has(run.taskId) || (lastByTask.get(run.taskId)?.startedAt ?? '') < run.startedAt) lastByTask.set(run.taskId, run);
  for (const task of tasks) {
    const run = lastByTask.get(task.id);
    if (run) { task.executionStatus = run.status; Object.assign(task, { lastRunId: run.id, lastRunAt: run.startedAt }); }
  }
  for (const module of modules) {
    const related = tasks.filter(task => task.moduleId === module.id);
    module.activeTaskCount = related.filter(task => task.status === 'active' || task.status === 'ready').length;
    const latest = related.map(task => lastByTask.get(task.id)).filter((run): run is TestRun => Boolean(run)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (latest) Object.assign(module, { lastRunStatus: latest.status, lastRunAt: latest.startedAt });
  }
  for (const [name, entries] of Object.entries({ modules, tasks, memories, skills })) writeJsonAtomic(qaPath(root, 'index', `${name}.json`), { version: 1, updatedAt: timestamp, [name]: entries });
  return { modules: modules.length, tasks: tasks.length, memories: memories.length, skills: skills.length, runs: runs.length };
}

export function readIndex<T>(root: string, name: 'modules' | 'tasks' | 'memories' | 'skills'): T[] {
  const path = qaPath(root, 'index', `${name}.json`);
  if (!existsSync(path)) return [];
  return (readJson<Record<string, T[]>>(path)[name] ?? []);
}
