import { bindTaskSession, resolveActiveTaskSession } from './session.ts';
import type { ContinueResult, NextAction } from './types.ts';
import { workflowStatus } from './workflow.ts';
import { finalizeTask } from './task-finalizer.ts';

function actionOwner(action: NextAction): 'runtime' | 'agent' | 'host' | 'human' {
  if (action.requiredActor) return action.requiredActor;
  return action.requiresHuman ? 'human' : 'agent';
}

function selectionMessage(candidates: NonNullable<ContinueResult['candidates']>): string {
  const items = candidates.map((candidate, index) => `${index + 1}. ${candidate.title}`).join('\n');
  return `Multiple unfinished QA tasks are available. Choose one to continue:\n${items}`;
}

export function continueCurrentTask(root: string, sessionKey?: string): ContinueResult {
  const resolution = resolveActiveTaskSession(root, sessionKey);
  if (resolution.status === 'no_active_task') {
    return {
      apiVersion: 'qa-agent/continue/v1',
      kind: 'ContinueResult',
      status: 'no_active_task',
      userMessage: 'No unfinished QA task is available. Start a new Quick Check or bind a specific Task.',
    };
  }
  if (resolution.status === 'task_selection_required') {
    return {
      apiVersion: 'qa-agent/continue/v1',
      kind: 'ContinueResult',
      status: 'task_selection_required',
      candidates: resolution.candidates,
      userMessage: selectionMessage(resolution.candidates),
    };
  }

  let workflow = workflowStatus(root, resolution.binding.moduleId, resolution.binding.taskId);
  const session = bindTaskSession(root, {
    sessionKey,
    host: resolution.binding.host,
    moduleId: resolution.binding.moduleId,
    taskId: resolution.binding.taskId,
    runId: workflow.runId ?? resolution.binding.runId,
  });
  let action = workflow.nextActions[0];

  if (action?.id === 'finalize_task' && action.requiredActor === 'runtime') {
    const finalization = finalizeTask(root, resolution.binding.moduleId, resolution.binding.taskId, workflow.runId ?? resolution.binding.runId);
    workflow = workflowStatus(root, resolution.binding.moduleId, resolution.binding.taskId);
    action = workflow.nextActions[0];
    const finalizedSession = bindTaskSession(root, {
      sessionKey,
      host: resolution.binding.host,
      moduleId: resolution.binding.moduleId,
      taskId: resolution.binding.taskId,
      runId: finalization.sourceRunId,
    });
    if (finalization.status === 'failed') {
      return {
        apiVersion: 'qa-agent/continue/v1', kind: 'ContinueResult', status: 'blocked', session: finalizedSession,
        task: resolution.task, workflow, finalization,
        nextAction: workflow.nextActions[0] ? { id: workflow.nextActions[0].id, owner: actionOwner(workflow.nextActions[0]), description: workflow.nextActions[0].description, command: workflow.nextActions[0].command } : undefined,
        userMessage: `QA task “${resolution.task.title}” result assets could not be finalized yet: ${finalization.error}. Saved Run evidence remains available and qa-agent continue can retry.`,
      };
    }
    return {
      apiVersion: 'qa-agent/continue/v1', kind: 'ContinueResult', status: 'completed', session: finalizedSession,
      task: { ...resolution.task, taskState: workflow.taskState, updatedAt: new Date().toISOString() }, workflow, finalization,
      nextAction: action ? { id: action.id, owner: actionOwner(action), description: action.description, command: action.command } : undefined,
      userMessage: `QA task “${resolution.task.title}” is complete. The Runtime report, Task PRD, screenshots, and evidence are finalized.`,
    };
  }

  const nextAction = action
    ? { id: action.id, owner: actionOwner(action), description: action.description, command: action.command }
    : undefined;

  if (workflow.taskState === 'archived' || (workflow.workflowStatus === 'completed' && workflow.workflowPhase === 'archive')) {
    return {
      apiVersion: 'qa-agent/continue/v1',
      kind: 'ContinueResult',
      status: 'completed',
      session,
      task: resolution.task,
      workflow,
      userMessage: `QA task “${resolution.task.title}” is complete and archived.`,
    };
  }

  if (workflow.workflowStatus === 'completed' && workflow.taskState === 'completed') {
    return {
      apiVersion: 'qa-agent/continue/v1', kind: 'ContinueResult', status: 'completed', session,
      task: resolution.task, workflow, nextAction,
      userMessage: `QA task “${resolution.task.title}” is complete and its result assets are finalized.`,
    };
  }

  if (workflow.workflowStatus === 'completed' || workflow.workflowStatus === 'result_ready') {
    return {
      apiVersion: 'qa-agent/continue/v1',
      kind: 'ContinueResult',
      status: 'result_ready',
      session,
      task: resolution.task,
      workflow,
      nextAction,
      userMessage: `QA task “${resolution.task.title}” has a Runtime result ready for review and asset finalization.`,
    };
  }

  if (nextAction?.owner === 'human') {
    return {
      apiVersion: 'qa-agent/continue/v1',
      kind: 'ContinueResult',
      status: 'human_decision_required',
      session,
      task: resolution.task,
      workflow,
      nextAction,
      userMessage: `QA task “${resolution.task.title}” needs one user decision: ${nextAction.description}`,
    };
  }

  if (workflow.workflowStatus === 'blocked') {
    return {
      apiVersion: 'qa-agent/continue/v1',
      kind: 'ContinueResult',
      status: 'blocked',
      session,
      task: resolution.task,
      workflow,
      nextAction,
      userMessage: `QA task “${resolution.task.title}” is temporarily blocked: ${nextAction?.description ?? workflow.nextAllowedAction} Saved progress remains available.`,
    };
  }

  return {
    apiVersion: 'qa-agent/continue/v1',
    kind: 'ContinueResult',
    status: 'action_ready',
    session,
    task: resolution.task,
    workflow,
    nextAction,
    userMessage: nextAction
      ? `Continue QA task “${resolution.task.title}”: ${nextAction.description}`
      : `QA task “${resolution.task.title}” has no pending action.`,
  };
}
