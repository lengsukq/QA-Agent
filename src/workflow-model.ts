import { appendTaskEvent } from './events.ts';
import { now } from './store.ts';
import type { TaskLifecycleState, TestTask } from './types.ts';

const allowedTransitions: Record<TaskLifecycleState, TaskLifecycleState[]> = {
  draft: ['planning', 'awaiting_approval', 'ready', 'blocked', 'retired'],
  planning: ['awaiting_approval', 'blocked', 'paused', 'retired'],
  awaiting_approval: ['planning', 'ready', 'blocked', 'paused', 'retired'],
  ready: ['planning', 'awaiting_approval', 'running', 'blocked', 'paused', 'retired'],
  running: ['reviewing_result', 'blocked', 'paused'],
  reviewing_result: ['planning', 'awaiting_approval', 'running', 'completed', 'blocked', 'paused', 'retired'],
  completed: ['planning', 'awaiting_approval', 'running', 'archived', 'retired'],
  archived: [],
  blocked: ['planning', 'awaiting_approval', 'ready', 'running', 'paused', 'retired'],
  paused: ['planning', 'awaiting_approval', 'ready', 'running', 'blocked', 'retired'],
  retired: [],
};

export function taskState(status: TestTask['metadata']['status'] | undefined): TaskLifecycleState {
  return status ?? 'draft';
}

export function transitionTaskState(
  root: string,
  task: TestTask,
  toState: TaskLifecycleState,
  eventType: string,
  reasonCode: string,
  options: { actor?: { type: 'human' | 'agent' | 'runtime' | 'host'; id: string }; artifactHash?: string; idempotencyKey?: string; metadata?: Record<string, unknown>; allowSame?: boolean } = {},
): void {
  const fromState = taskState(task.metadata.status);
  if (fromState === toState && options.allowSame !== false) return;
  if (!allowedTransitions[fromState].includes(toState)) throw new Error(`Invalid Task transition ${fromState} -> ${toState} (${eventType}).`);
  task.metadata.status = toState;
  task.updatedAt = now();
  appendTaskEvent(root, {
    type: eventType,
    actor: options.actor ?? { type: 'runtime', id: 'qa-agent-runtime' },
    moduleId: task.metadata.moduleId,
    taskId: task.metadata.id,
    fromState,
    toState,
    reasonCode,
    artifactHash: options.artifactHash,
    idempotencyKey: options.idempotencyKey ?? `${eventType}:${task.metadata.version}:${fromState}:${toState}`,
    metadata: options.metadata,
  });
}
