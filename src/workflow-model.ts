import { appendTaskEvent } from './events.ts';
import { now } from './store.ts';
import type { TaskLifecycleState, TestTask } from './types.ts';

const allowedTransitions: Record<TaskLifecycleState, TaskLifecycleState[]> = {
  draft: ['planning', 'awaiting_approval', 'ready', 'needs_input', 'deprecated', 'superseded'],
  planning: ['awaiting_approval', 'needs_input', 'blocked', 'paused', 'deprecated', 'superseded'],
  awaiting_approval: ['planning', 'ready', 'needs_input', 'blocked', 'paused', 'deprecated', 'superseded'],
  ready: ['planning', 'awaiting_approval', 'running', 'blocked', 'paused', 'deprecated', 'superseded'],
  running: ['reviewing_result', 'blocked', 'paused'],
  reviewing_result: ['planning', 'awaiting_approval', 'running', 'completed', 'blocked', 'paused', 'deprecated', 'superseded'],
  completed: ['planning', 'awaiting_approval', 'running', 'archived', 'deprecated', 'superseded'],
  archived: [],
  needs_input: ['planning', 'awaiting_approval', 'blocked', 'paused', 'deprecated', 'superseded'],
  blocked: ['planning', 'awaiting_approval', 'ready', 'running', 'paused', 'deprecated', 'superseded'],
  paused: ['planning', 'awaiting_approval', 'ready', 'running', 'blocked', 'deprecated', 'superseded'],
  deprecated: ['superseded'],
  superseded: [],
};

export function normalizeTaskState(status: TestTask['metadata']['status'] | undefined): TaskLifecycleState {
  if (status === 'active') return 'ready';
  if (status === 'needs_review') return 'awaiting_approval';
  if (status === 'finalizing' || status === 'regression_ready') return 'reviewing_result';
  return status ?? 'draft';
}

export function transitionTaskState(
  root: string,
  task: TestTask,
  toState: TaskLifecycleState,
  eventType: string,
  reasonCode: string,
  options: { actor?: { type: 'human' | 'agent' | 'runtime' | 'host' | 'migration'; id: string }; artifactHash?: string; idempotencyKey?: string; metadata?: Record<string, unknown>; allowSame?: boolean } = {},
): void {
  const fromState = normalizeTaskState(task.metadata.status);
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
