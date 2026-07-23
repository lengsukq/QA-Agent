import { existsSync } from 'node:fs';
import { readJson } from './store.ts';
import { readTask, taskPrdPath, taskSourceRunPath, taskSourceRunReportPath } from './project.ts';
import { closeTaskSession, resolveActiveTaskSession } from './session.ts';
import { finalizeTask } from './task-finalizer.ts';
import type { FinishResult, TestRun, TestTask } from './types.ts';
import { taskState as resolveTaskState } from './workflow-model.ts';
import { workflowStatus } from './workflow.ts';
import { artifactLinksSentence, userFacingArtifact } from './user-facing-artifacts.ts';

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
    if (finalization?.status === 'failed' || resolveTaskState(task.metadata.status) !== 'completed' || task.finalization?.status !== 'completed') {
      return {
        apiVersion: 'qa-agent/finish/v1', kind: 'FinishResult', status: 'blocked', session: resolution.binding, task: resolution.task, workflow, finalization,
        userMessage: `QA task “${resolution.task.title}” cannot be finished yet because its Runtime report or PRD is incomplete.${finalization?.error ? ` ${finalization.error}` : ''} Use qa-agent continue after resolving the blocker.`,
      };
    }
  }

  const closure = closeTaskSession(root, { ...resolution.binding, runId: run?.id ?? resolution.binding.runId }, sessionKey);
  const persistentTaskPreserved = task.metadata.mode !== 'quick';
  const userFacingArtifacts = [
    ...(existsSync(taskPrdPath(root, task.metadata.moduleId, task.metadata.id)) ? [userFacingArtifact(root, taskPrdPath(root, task.metadata.moduleId, task.metadata.id), '查看测试方案 PRD', 'task-prd')] : []),
    ...(existsSync(taskSourceRunReportPath(root, task.metadata.moduleId, task.metadata.id)) ? [userFacingArtifact(root, taskSourceRunReportPath(root, task.metadata.moduleId, task.metadata.id), '查看测试报告', 'source-run-report')] : []),
  ];
  return {
    apiVersion: 'qa-agent/finish/v1', kind: 'FinishResult', status: persistentTaskPreserved ? 'task_preserved' : 'finished',
    session: resolution.binding, closure, task: { ...resolution.task, taskState: resolveTaskState(task.metadata.status), updatedAt: task.updatedAt }, workflow, finalization, userFacingArtifacts,
    userMessage: persistentTaskPreserved
      ? `The current QA session is finished. Persistent QA task “${resolution.task.title}” remains available in its current state and can be explicitly resumed later.${userFacingArtifacts.length ? ` ${artifactLinksSentence(userFacingArtifacts)}` : ''}`
      : `QA task “${resolution.task.title}” is complete and the current session is finished. The Runtime report, PRD, screenshots, and evidence are saved.${userFacingArtifacts.length ? ` ${artifactLinksSentence(userFacingArtifacts)}` : ''}`,
  };
}
