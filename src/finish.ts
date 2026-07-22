import { existsSync } from 'node:fs';
import { readJson } from './store.ts';
import { readTask, taskSourceRunPath } from './project.ts';
import { closeTaskSession, resolveActiveTaskSession } from './session.ts';
import { finalizeTask } from './task-finalizer.ts';
import type { FinishResult, TestRun, TestTask } from './types.ts';
import { normalizeTaskState } from './workflow-model.ts';
import { workflowStatus } from './workflow.ts';

function latestRun(root: string, task: TestTask): TestRun | undefined {
  const path = taskSourceRunPath(root, task.metadata.moduleId, task.metadata.id);
  return existsSync(path) ? readJson<TestRun>(path) : undefined;
}

export function finishCurrentTask(root: string, sessionKey?: string): FinishResult {
  const resolution = resolveActiveTaskSession(root, sessionKey);
  if (resolution.status === 'no_active_task') {
    return { apiVersion: 'qa-agent/finish/v1', kind: 'FinishResult', status: 'no_active_task', userMessage: 'No active QA session is available to finish.' };
  }
  if (resolution.status === 'task_selection_required') {
    return {
      apiVersion: 'qa-agent/finish/v1', kind: 'FinishResult', status: 'task_selection_required', candidates: resolution.candidates,
      userMessage: `Several unfinished QA tasks are available. Select the Task to bind before finishing: ${resolution.candidates.map((item, index) => `${index + 1}. ${item.title}`).join(' ')}`,
    };
  }

  let task = readTask(root, resolution.binding.moduleId, resolution.binding.taskId);
  let workflow = workflowStatus(root, task.metadata.moduleId, task.metadata.id);
  let run = latestRun(root, task);
  if (run?.status === 'running') {
    return {
      apiVersion: 'qa-agent/finish/v1', kind: 'FinishResult', status: 'blocked', session: resolution.binding, task: resolution.task, workflow,
      userMessage: `QA task “${resolution.task.title}” is still running. Complete or pause it before ending the session so evidence and cleanup remain consistent.`,
    };
  }

  let finalization: FinishResult['finalization'];
  if (task.metadata.mode === 'quick') {
    if (workflow.nextActions[0]?.id === 'finalize_task') {
      finalization = finalizeTask(root, task.metadata.moduleId, task.metadata.id, workflow.runId ?? resolution.binding.runId);
      task = readTask(root, task.metadata.moduleId, task.metadata.id);
      workflow = workflowStatus(root, task.metadata.moduleId, task.metadata.id);
      run = latestRun(root, task);
    }
    if (finalization?.status === 'failed' || normalizeTaskState(task.metadata.status) !== 'completed' || task.finalization?.status !== 'completed') {
      return {
        apiVersion: 'qa-agent/finish/v1', kind: 'FinishResult', status: 'blocked', session: resolution.binding, task: resolution.task, workflow, finalization,
        userMessage: `QA task “${resolution.task.title}” cannot be finished yet because its Runtime report or PRD is incomplete.${finalization?.error ? ` ${finalization.error}` : ''} Use qa-agent continue after resolving the blocker.`,
      };
    }
  }

  const closure = closeTaskSession(root, { ...resolution.binding, runId: run?.id ?? resolution.binding.runId }, sessionKey);
  const strictPreserved = task.metadata.mode !== 'quick';
  return {
    apiVersion: 'qa-agent/finish/v1', kind: 'FinishResult', status: strictPreserved ? 'task_preserved' : 'finished',
    session: resolution.binding, closure, task: { ...resolution.task, taskState: normalizeTaskState(task.metadata.status), updatedAt: task.updatedAt }, workflow, finalization,
    userMessage: strictPreserved
      ? `The current QA session is finished. Strict task “${resolution.task.title}” remains available in its current state and can be explicitly resumed later.`
      : `QA task “${resolution.task.title}” is complete and the current session is finished. The Runtime report, PRD, screenshots, and evidence are saved.`,
  };
}
