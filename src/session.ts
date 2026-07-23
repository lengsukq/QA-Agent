import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readIndex, rebuildIndexes } from './indexer.ts';
import { qaPath, readTask, taskPath } from './project.ts';
import { isSafeId, listFiles, now, readJson, withFileLock, writeJsonAtomic } from './store.ts';
import type { QaMode, QaSessionBinding, QaSessionClosure, SessionTaskCandidate, TaskLifecycleState } from './types.ts';
import { taskState as resolveTaskState } from './workflow-model.ts';

interface IndexedTask {
  id: string;
  moduleId: string;
  name: string;
  status: string;
  taskState: TaskLifecycleState;
  mode?: QaMode;
  updatedAt: string;
  currentRunId?: string;
  sourceRunId?: string;
}

export interface SessionIdentity {
  sessionKey: string;
  storageKey: string;
  fallback: boolean;
}

export interface BindSessionInput {
  sessionKey?: string;
  host?: string;
  moduleId: string;
  taskId: string;
  runId?: string;
}

export type ActiveSessionResolution =
  | { status: 'resolved'; binding: QaSessionBinding; task: SessionTaskCandidate; autoBound: boolean }
  | { status: 'no_active_task'; candidates: [] }
  | { status: 'task_selection_required'; candidates: SessionTaskCandidate[] };

function sessionDirectory(root: string): string {
  return qaPath(root, '.runtime', 'sessions');
}

function currentTaskPath(root: string): string {
  return qaPath(root, '.runtime', 'current-task.json');
}

function sessionPath(root: string, storageKey: string): string {
  return join(sessionDirectory(root), `${storageKey}.json`);
}

function sessionClosurePath(root: string, storageKey: string): string {
  return join(sessionDirectory(root), `${storageKey}.closed.json`);
}

function storageKeyFor(sessionKey: string): string {
  const slug = sessionKey.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
  const hash = createHash('sha256').update(sessionKey).digest('hex').slice(0, 12);
  return `${slug}-${hash}`;
}

export function resolveSessionIdentity(explicitSessionKey?: string): SessionIdentity {
  const explicit = explicitSessionKey?.trim();
  const environment = process.env.QA_AGENT_SESSION_KEY?.trim();
  const sessionKey = explicit || environment || 'default';
  return { sessionKey, storageKey: storageKeyFor(sessionKey), fallback: !explicit && !environment };
}

function candidateFromIndex(task: IndexedTask): SessionTaskCandidate {
  return {
    moduleId: task.moduleId,
    taskId: task.id,
    title: task.name,
    taskState: task.taskState,
    mode: task.mode,
    updatedAt: task.updatedAt,
  };
}

function indexedTasks(root: string): IndexedTask[] {
  rebuildIndexes(root);
  return readIndex<IndexedTask>(root, 'tasks');
}

function usableBinding(root: string, binding: QaSessionBinding): boolean {
  try {
    if (!existsSync(taskPath(root, binding.moduleId, binding.taskId))) return false;
    const task = readTask(root, binding.moduleId, binding.taskId);
    return !['archived', 'deprecated', 'superseded'].includes(resolveTaskState(task.metadata.status));
  } catch {
    return false;
  }
}

function validBinding(value: QaSessionBinding | undefined, identity?: SessionIdentity): value is QaSessionBinding {
  if (!value || value.apiVersion !== 'qa-agent/session/v1') return false;
  if (!value.sessionKey || !isSafeId(value.moduleId) || !isSafeId(value.taskId) || !isSafeId(value.storageKey)) return false;
  if (identity && (value.sessionKey !== identity.sessionKey || value.storageKey !== identity.storageKey)) return false;
  return Boolean(value.boundAt && value.lastActiveAt);
}

export function bindTaskSession(root: string, input: BindSessionInput): QaSessionBinding {
  const identity = resolveSessionIdentity(input.sessionKey);
  return withFileLock(qaPath(root, '.locks', `session-${identity.storageKey}.lock`), () => {
    const task = readTask(root, input.moduleId, input.taskId);
    const timestamp = now();
    const existing = readTaskSession(root, input.sessionKey);
    const binding: QaSessionBinding = {
      apiVersion: 'qa-agent/session/v1',
      sessionKey: identity.sessionKey,
      storageKey: identity.storageKey,
      host: input.host?.trim() || process.env.QA_AGENT_HOST?.trim() || existing?.host,
      moduleId: task.metadata.moduleId,
      taskId: task.metadata.id,
      runId: input.runId ?? (existing?.moduleId === task.metadata.moduleId && existing.taskId === task.metadata.id ? existing.runId : undefined),
      boundAt: existing?.moduleId === task.metadata.moduleId && existing.taskId === task.metadata.id ? existing.boundAt : timestamp,
      lastActiveAt: timestamp,
    };
    const closure = sessionClosurePath(root, identity.storageKey);
    if (existsSync(closure)) unlinkSync(closure);
    writeJsonAtomic(sessionPath(root, identity.storageKey), binding);
    if (identity.fallback) writeJsonAtomic(currentTaskPath(root), binding);
    return binding;
  });
}

export function readTaskSession(root: string, explicitSessionKey?: string): QaSessionBinding | undefined {
  const identity = resolveSessionIdentity(explicitSessionKey);
  const primary = sessionPath(root, identity.storageKey);
  if (existsSync(primary)) {
    try {
      const value = readJson<QaSessionBinding>(primary);
      if (validBinding(value, identity)) return value;
    } catch { /* Invalid session pointers are ignored and replaced on the next bind. */ }
  }
  const fallback = currentTaskPath(root);
  if (identity.fallback && existsSync(fallback)) {
    try {
      const value = readJson<QaSessionBinding>(fallback);
      if (validBinding(value, identity)) return value;
    } catch { /* Invalid fallback pointers are ignored. */ }
  }
  return undefined;
}

function validClosure(value: QaSessionClosure | undefined, identity?: SessionIdentity): value is QaSessionClosure {
  if (!value || value.apiVersion !== 'qa-agent/session-closure/v1' || value.reason !== 'finish') return false;
  if (!value.sessionKey || !isSafeId(value.moduleId) || !isSafeId(value.taskId) || !isSafeId(value.storageKey) || !value.closedAt) return false;
  if (identity && (value.sessionKey !== identity.sessionKey || value.storageKey !== identity.storageKey)) return false;
  return true;
}

export function readTaskSessionClosure(root: string, explicitSessionKey?: string): QaSessionClosure | undefined {
  const identity = resolveSessionIdentity(explicitSessionKey);
  const path = sessionClosurePath(root, identity.storageKey);
  if (!existsSync(path)) return undefined;
  try {
    const value = readJson<QaSessionClosure>(path);
    return validClosure(value, identity) ? value : undefined;
  } catch { return undefined; }
}

export function closeTaskSession(root: string, binding: QaSessionBinding, explicitSessionKey?: string): QaSessionClosure {
  const identity = resolveSessionIdentity(explicitSessionKey);
  if (binding.sessionKey !== identity.sessionKey || binding.storageKey !== identity.storageKey) throw new Error('Session binding does not match the requested Session identity.');
  return withFileLock(qaPath(root, '.locks', `session-${identity.storageKey}.lock`), () => {
    const closure: QaSessionClosure = {
      apiVersion: 'qa-agent/session-closure/v1',
      sessionKey: identity.sessionKey,
      storageKey: identity.storageKey,
      host: binding.host,
      moduleId: binding.moduleId,
      taskId: binding.taskId,
      runId: binding.runId,
      reason: 'finish',
      closedAt: now(),
    };
    const primary = sessionPath(root, identity.storageKey);
    if (existsSync(primary)) unlinkSync(primary);
    const fallback = currentTaskPath(root);
    if (identity.fallback && existsSync(fallback)) unlinkSync(fallback);
    writeJsonAtomic(sessionClosurePath(root, identity.storageKey), closure);
    return closure;
  });
}

export function clearTaskSession(root: string, explicitSessionKey?: string): QaSessionBinding | undefined {
  const identity = resolveSessionIdentity(explicitSessionKey);
  return withFileLock(qaPath(root, '.locks', `session-${identity.storageKey}.lock`), () => {
    const existing = readTaskSession(root, explicitSessionKey);
    const primary = sessionPath(root, identity.storageKey);
    if (existsSync(primary)) unlinkSync(primary);
    const fallback = currentTaskPath(root);
    if (identity.fallback && existsSync(fallback)) unlinkSync(fallback);
    const closure = sessionClosurePath(root, identity.storageKey);
    if (existsSync(closure)) unlinkSync(closure);
    return existing;
  });
}

export function clearTaskSessionIfMatches(root: string, moduleId: string, taskId: string, explicitSessionKey?: string): boolean {
  const existing = readTaskSession(root, explicitSessionKey);
  if (!existing || existing.moduleId !== moduleId || existing.taskId !== taskId) return false;
  clearTaskSession(root, explicitSessionKey);
  return true;
}

export function listTaskSessions(root: string): QaSessionBinding[] {
  return listFiles(sessionDirectory(root), path => path.endsWith('.json') && !path.endsWith('.closed.json'))
    .flatMap(path => {
      try {
        const value = readJson<QaSessionBinding>(path);
        return validBinding(value) ? [value] : [];
      } catch { return []; }
    })
    .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
}

export function resolveActiveTaskSession(root: string, explicitSessionKey?: string): ActiveSessionResolution {
  const tasks = indexedTasks(root);
  const indexedByKey = new Map(tasks.map(task => [`${task.moduleId}/${task.id}`, task]));
  const existing = readTaskSession(root, explicitSessionKey);

  if (existing) {
    if (usableBinding(root, existing)) {
      const indexed = indexedByKey.get(`${existing.moduleId}/${existing.taskId}`);
      const task = indexed
        ? candidateFromIndex(indexed)
        : (() => {
            const manifest = readTask(root, existing.moduleId, existing.taskId);
            return {
              moduleId: existing.moduleId,
              taskId: existing.taskId,
              title: manifest.metadata.name,
              taskState: resolveTaskState(manifest.metadata.status),
              mode: manifest.metadata.mode,
              updatedAt: manifest.updatedAt,
            } satisfies SessionTaskCandidate;
          })();
      const binding = bindTaskSession(root, {
        sessionKey: explicitSessionKey,
        host: existing.host,
        moduleId: existing.moduleId,
        taskId: existing.taskId,
        runId: indexed?.currentRunId ?? indexed?.sourceRunId ?? existing.runId,
      });
      return { status: 'resolved', binding, task, autoBound: false };
    }
    clearTaskSession(root, explicitSessionKey);
  }

  if (readTaskSessionClosure(root, explicitSessionKey)) return { status: 'no_active_task', candidates: [] };

  const active = tasks
    .filter(task => !['completed', 'archived', 'deprecated', 'superseded'].includes(task.taskState))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const candidates = active.map(candidateFromIndex);
  if (!candidates.length) return { status: 'no_active_task', candidates: [] };
  if (candidates.length > 1) return { status: 'task_selection_required', candidates };

  const selected = active[0]!;
  const binding = bindTaskSession(root, {
    sessionKey: explicitSessionKey,
    moduleId: selected.moduleId,
    taskId: selected.id,
    runId: selected.currentRunId ?? selected.sourceRunId,
  });
  return { status: 'resolved', binding, task: candidateFromIndex(selected), autoBound: true };
}
