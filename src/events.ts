import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qaPath, taskDirectory } from './project.ts';
import { appendJsonl, now, withFileLock } from './store.ts';
import type { TaskLifecycleState } from './types.ts';

export interface TaskEvent {
  seq: number;
  id: string;
  type: string;
  at: string;
  actor: { type: 'human' | 'agent' | 'runtime' | 'host'; id: string };
  moduleId: string;
  taskId: string;
  fromState?: TaskLifecycleState;
  toState?: TaskLifecycleState;
  reasonCode: string;
  artifactHash?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export function taskEventsPath(root: string, moduleId: string, taskId: string): string {
  return join(taskDirectory(root, moduleId, taskId), 'events.jsonl');
}

export function readTaskEvents(root: string, moduleId: string, taskId: string): TaskEvent[] {
  const path = taskEventsPath(root, moduleId, taskId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as TaskEvent; }
    catch { throw new Error(`${path}: invalid JSONL event at line ${index + 1}.`); }
  });
}

export function appendTaskEvent(root: string, input: Omit<TaskEvent, 'seq' | 'id' | 'at'> & Partial<Pick<TaskEvent, 'id' | 'at'>>): TaskEvent {
  const lock = qaPath(root, '.locks', `events-${input.moduleId}-${input.taskId}.lock`);
  return withFileLock(lock, () => {
    const existing = readTaskEvents(root, input.moduleId, input.taskId);
    const duplicate = existing.find(event => event.idempotencyKey === input.idempotencyKey);
    if (duplicate) {
      const comparable = (event: Omit<TaskEvent, 'seq' | 'id' | 'at'> | TaskEvent) => JSON.stringify({ type: event.type, actor: event.actor, moduleId: event.moduleId, taskId: event.taskId, fromState: event.fromState, toState: event.toState, reasonCode: event.reasonCode, artifactHash: event.artifactHash, metadata: event.metadata });
      if (comparable(duplicate) !== comparable(input)) throw new Error(`Task event idempotency conflict for ${input.idempotencyKey}.`);
      return duplicate;
    }
    const event: TaskEvent = {
      ...input,
      seq: (existing.at(-1)?.seq ?? 0) + 1,
      id: input.id ?? `evt-${randomUUID()}`,
      at: input.at ?? now(),
    };
    appendJsonl(taskEventsPath(root, input.moduleId, input.taskId), event);
    return event;
  });
}

export function resumeToken(moduleId: string, taskId: string, runId: string | undefined, seq: number | undefined, progress?: string | number): string {
  return `task:${moduleId}/${taskId}${runId ? `:run:${runId}` : ''}:seq:${seq ?? 0}${progress === undefined ? '' : `:progress:${progress}`}`;
}

export function workflowContextHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
