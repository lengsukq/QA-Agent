import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { modulePath, qaPath, taskDirectory } from './project.ts';
import { assertSafeId, listFiles, now, readJson, withFileLock, writeJsonAtomic } from './store.ts';
import type { ProjectMemory, TestRun, TestTask } from './types.ts';

function memoryPath(root: string, moduleId: string | undefined, id: string, taskId?: string): string {
  assertSafeId(id, 'memory id');
  return taskId && moduleId ? join(taskDirectory(root, moduleId, taskId), 'memory', `${id}.json`) : moduleId ? join(modulePath(root, moduleId), 'memory', `${id}.json`) : qaPath(root, 'shared-memory', 'entries', `${id}.json`);
}

function redact(value: string): string {
  return value.replace(/(password|token|secret|cookie|authorization|private.?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function assertSafeContent(value: string): void {
  if (/(?:password|token|secret|cookie|authorization|private.?key)\s*[:=]\s*[^\s,;]+/i.test(value)) throw new Error('Memory content appears to contain a secret. Store an env: secret reference instead.');
}

export function listModuleMemories(root: string, moduleId: string): ProjectMemory[] {
  const folder = join(modulePath(root, moduleId), 'memory');
  return listFiles(folder, path => path.endsWith('.json')).flatMap(path => {
    const value = readJson<ProjectMemory | ProjectMemory[]>(path);
    return Array.isArray(value) ? value : [value];
  });
}

export function createMemoryCandidate(root: string, input: Omit<ProjectMemory, '$schema' | 'status' | 'version' | 'createdAt' | 'updatedAt'>): { memory: ProjectMemory; conflicts: string[] } {
  return withFileLock(qaPath(root, '.locks', 'memories.lock'), () => {
    assertSafeContent(`${input.title}\n${input.content}`);
    const path = memoryPath(root, input.moduleId, input.id, input.taskId);
    if (existsSync(path)) throw new Error(`Memory ${input.id} already exists.`);
    const existing = input.moduleId ? listModuleMemories(root, input.moduleId) : [];
    const conflicts = existing.filter(item => item.status === 'active' && item.type === input.type && item.title.trim().toLowerCase() === input.title.trim().toLowerCase()).map(item => item.id);
    const timestamp = now();
    const memory: ProjectMemory = { $schema: input.taskId ? '../../../../schemas/memory.schema.json' : '../../../schemas/memory.schema.json', ...input, content: redact(input.content), status: 'candidate', version: 1, createdAt: timestamp, updatedAt: timestamp };
    writeJsonAtomic(path, memory);
    return { memory, conflicts };
  });
}

export function reviewMemory(root: string, moduleId: string, id: string, decision: 'approve' | 'reject', level: ProjectMemory['knowledgeLevel'] = 'confirmed', taskId?: string): ProjectMemory {
  return withFileLock(qaPath(root, '.locks', 'memories.lock'), () => {
    const path = memoryPath(root, moduleId, id, taskId);
    const memory = readJson<ProjectMemory>(path);
    if (memory.status !== 'candidate') throw new Error(`Memory ${id} is not awaiting review.`);
    if (decision === 'reject') {
      memory.status = 'deprecated'; memory.knowledgeLevel = 'deprecated'; memory.updatedAt = now(); writeJsonAtomic(path, memory); return memory;
    }
    const conflicts = listModuleMemories(root, moduleId).filter(item => item.id !== id && item.status === 'active' && item.type === memory.type && item.title.trim().toLowerCase() === memory.title.trim().toLowerCase());
    for (const old of conflicts) {
      old.status = 'superseded'; old.updatedAt = now(); writeJsonAtomic(memoryPath(root, moduleId, old.id, old.taskId), old);
    }
    memory.status = 'active'; memory.knowledgeLevel = level; memory.version = Math.max(memory.version, ...conflicts.map(item => item.version + 1)); memory.supersedes = conflicts[0]?.id; memory.updatedAt = now();
    writeJsonAtomic(path, memory); return memory;
  });
}

export function curateFailedRun(root: string, task: TestTask, run: TestRun): string | undefined {
  if (run.status !== 'failed') return undefined;
  const failed = run.scenarioResults.filter(item => item.status === 'failed');
  if (!failed.length) return undefined;
  const id = `issue-${task.metadata.id.slice(0, 34)}-${run.id.slice(-8)}`.replace(/[^a-z0-9-]/g, '-');
  const path = memoryPath(root, task.metadata.moduleId, id);
  if (existsSync(path)) return id;
  const content = redact(failed.map(item => `${item.scenarioId}: ${item.detail ?? 'assertion failed'}`).join('\n'));
  const result = createMemoryCandidate(root, {
    id, moduleId: task.metadata.moduleId, taskId: task.metadata.id, type: 'known_issue', title: `Failed QA run: ${task.metadata.name}`, content,
    scope: { environments: [run.context.environment], platforms: [run.context.platform], roles: [run.context.role] }, knowledgeLevel: 'observed', confidence: 0.9,
    importance: task.metadata.priority === 'p0' ? 'critical' : task.metadata.priority === 'p1' ? 'high' : 'medium', source: { type: 'test_run', reference: run.id },
  });
  return result.memory.id;
}

/** Persist observed, reviewable business outcomes without promoting them to project truth. */
export function curateObservedBusinessRules(root: string, task: TestTask, run: TestRun): string | undefined {
  if (!['passed', 'adapted'].includes(run.status)) return undefined;
  const observations = (run.visualFindings ?? []).filter(item => item.status === 'passed');
  if (!observations.length) return undefined;
  const id = `observed-${task.metadata.id.slice(0, 31)}-${run.id.slice(-8)}`.replace(/[^a-z0-9-]/g, '-');
  const path = memoryPath(root, task.metadata.moduleId, id);
  if (existsSync(path)) return id;
  const content = observations.map(item => `Scenario: ${item.scenarioId}\nBusiness assertion: ${item.assertionId}\nExpected: ${item.expected}\nObserved: ${item.actual}`).join('\n\n');
  const result = createMemoryCandidate(root, {
    id, moduleId: task.metadata.moduleId, taskId: task.metadata.id, type: 'business_rule', title: `Observed business outcome: ${task.metadata.name}`, content,
    scope: { environments: [run.context.environment], platforms: [run.context.platform], roles: [run.context.role] }, knowledgeLevel: 'observed', confidence: 0.75,
    importance: task.metadata.priority === 'p0' ? 'critical' : task.metadata.priority === 'p1' ? 'high' : 'medium', source: { type: 'test_run', reference: run.id },
  });
  return result.memory.id;
}
