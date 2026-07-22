import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendTaskEvent } from './events.ts';
import { rebuildIndexes } from './indexer.ts';
import { createQuickTaskShell } from './planning.ts';
import { createModule, modulePath, readModule, readProject, readTask, saveTask, taskDirectory } from './project.ts';
import { assertSafeId, isSafeId } from './store.ts';
import type { RiskLevel, TestTask } from './types.ts';
import { transitionTaskState } from './workflow-model.ts';

export interface QuickCheckInput {
  request: string;
  moduleId?: string;
  taskId?: string;
  moduleName?: string;
  taskName?: string;
  platforms?: string[];
  riskLevel?: RiskLevel;
}

export interface QuickCheckPreparation {
  moduleId: string;
  taskId: string;
  moduleCreated: boolean;
  taskCreated: boolean;
  task: TestTask;
}

function requestSlug(request: string): string {
  const slug = request.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  if (isSafeId(slug)) return slug;
  return `quick-${createHash('sha256').update(request).digest('hex').slice(0, 10)}`;
}

export function resolveQuickCheckIdentity(input: QuickCheckInput): { moduleId: string; taskId: string } {
  const request = input.request.trim();
  if (!request) throw new Error('--request is required.');
  const moduleId = input.moduleId?.trim() || 'quick-checks';
  const taskId = input.taskId?.trim() || requestSlug(request);
  assertSafeId(moduleId, 'Quick Check module id');
  assertSafeId(taskId, 'Quick Check task id');
  return { moduleId, taskId };
}

export function prepareQuickCheck(root: string, input: QuickCheckInput): QuickCheckPreparation {
  const request = input.request.trim();
  const { moduleId, taskId } = resolveQuickCheckIdentity(input);
  const moduleCreated = !existsSync(join(modulePath(root, moduleId), 'module.json'));
  if (moduleCreated) {
    const project = readProject(root);
    createModule(root, {
      id: moduleId,
      name: input.moduleName ?? (moduleId === 'quick-checks' ? 'Quick Checks' : moduleId),
      description: request,
      platforms: input.platforms?.length ? input.platforms : project.platforms,
      riskLevel: input.riskLevel,
      businessGoals: [request],
    });
  }

  const taskCreated = !existsSync(join(taskDirectory(root, moduleId, taskId), 'task.json'));
  if (taskCreated) {
    const task = createQuickTaskShell(readModule(root, moduleId), taskId, request, input.taskName);
    saveTask(root, task);
    appendTaskEvent(root, {
      type: 'task_created',
      actor: { type: 'agent', id: 'qa-agent' },
      moduleId,
      taskId,
      toState: 'draft',
      reasonCode: 'quick_request_materialized',
      idempotencyKey: `quick-task-created:${moduleId}:${taskId}`,
      metadata: { requestSummary: request.slice(0, 160), mode: 'quick' },
    });
    transitionTaskState(root, task, 'ready', 'quick_task_ready', 'side_effect_only_policy', {
      actor: { type: 'runtime', id: 'qa-agent-runtime' },
      idempotencyKey: `quick-task-ready:${moduleId}:${taskId}`,
      metadata: { approvalPolicy: 'side-effect-only' },
    });
    saveTask(root, task);
  }

  const task = readTask(root, moduleId, taskId);
  if (task.metadata.mode !== 'quick' || task.metadata.approvalPolicy !== 'side-effect-only') {
    throw new Error(`Task ${moduleId}/${taskId} already exists as a strict Task. Use qa-agent start/test for that Task or choose another --task id.`);
  }
  rebuildIndexes(root);
  return { moduleId, taskId, moduleCreated, taskCreated, task };
}
