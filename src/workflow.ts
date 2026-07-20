import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { approvalIsCurrent } from './approval.ts';
import { checkCapabilities, platformCapabilities } from './capabilities.ts';
import { rebuildIndexes } from './indexer.ts';
import { createTaskSkeleton, taskPlan } from './planning.ts';
import { createModule, modulePath, readModule, readProjectPromptBundle, readTask, saveTask, taskDirectory } from './project.ts';
import { listFiles, readJson } from './store.ts';
import type { QaWorkflowState, RiskLevel, TestRun, WorkflowTodo } from './types.ts';

export interface WorkflowBootstrapInput {
  request: string;
  moduleId: string;
  taskId: string;
  moduleName?: string;
  taskName?: string;
  platforms?: string[];
  riskLevel?: RiskLevel;
}

function latestRun(root: string, moduleId: string, taskId: string): TestRun | undefined {
  const directory = join(taskDirectory(root, moduleId, taskId), 'runs');
  if (!existsSync(directory)) return undefined;
  return listFiles(directory, path => path.endsWith('/run.json'))
    .map(path => readJson<TestRun>(path))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

function todos(moduleReady: boolean, taskReady: boolean, approved: boolean, capabilityReady: boolean, run?: TestRun): WorkflowTodo[] {
  const running = run?.status === 'running';
  const completed = Boolean(run?.completedAt);
  return [
    { id: 'project', title: 'Load the active QA project and prompt bundle', status: 'completed' },
    { id: 'module', title: 'Resolve or create the business Module', status: moduleReady ? 'completed' : 'in_progress' },
    { id: 'task', title: 'Create the Task directory and test assets', status: taskReady ? 'completed' : moduleReady ? 'in_progress' : 'pending' },
    { id: 'plan', title: 'Review the generated Test Plan', status: taskReady ? 'completed' : 'pending' },
    { id: 'approval', title: 'Wait for explicit human approval', status: approved ? 'completed' : taskReady ? 'blocked' : 'pending', blocking: true },
    { id: 'capabilities', title: 'Verify host tools and permissions', status: capabilityReady ? 'completed' : approved ? 'blocked' : 'pending', blocking: true },
    { id: 'run', title: 'Start the approved Task Run', status: running || completed ? 'completed' : approved && capabilityReady ? 'in_progress' : 'pending' },
    { id: 'execute', title: 'Execute UI steps, assertions, and cleanup', status: running ? 'in_progress' : completed ? 'completed' : 'pending' },
    { id: 'finish', title: 'Complete the Run and inspect the report and OperationPlan result', status: completed ? 'completed' : 'pending' },
  ];
}

export function workflowStatus(root: string, moduleId: string, taskId: string, request?: string): QaWorkflowState {
  const moduleReady = existsSync(join(modulePath(root, moduleId), 'module.json'));
  const taskReady = moduleReady && existsSync(join(taskDirectory(root, moduleId, taskId), 'task.json'));
  const task = taskReady ? readTask(root, moduleId, taskId) : undefined;
  const approved = Boolean(task && approvalIsCurrent(task));
  const run = taskReady ? latestRun(root, moduleId, taskId) : undefined;
  const capabilityStatus = task ? checkCapabilities(root, [...new Set([...task.capabilities.required, ...platformCapabilities(task.scope.platforms[0] ?? 'web')])], task.capabilities.optional) : undefined;
  const capabilityReady = Boolean(capabilityStatus && !capabilityStatus.missing.length);
  const promptBundle = readProjectPromptBundle(root);
  let workflowStatus: QaWorkflowState['workflowStatus'];
  if (!promptBundle.current) workflowStatus = 'blocked';
  else if (!moduleReady || !taskReady) workflowStatus = 'setup_required';
  else if (!approved) workflowStatus = 'approval_required';
  else if (!capabilityReady) workflowStatus = 'blocked';
  else if (run?.status === 'running') workflowStatus = 'running';
  else if (run?.completedAt && ['passed', 'failed', 'adapted', 'inconclusive', 'not_applicable'].includes(run.status)) workflowStatus = 'completed';
  else if (run?.completedAt) workflowStatus = 'blocked';
  else workflowStatus = 'ready_to_run';
  const uiExecutionAllowed = workflowStatus === 'running' && Boolean(run?.id);
  const taskDirectoryRef = taskReady ? `.qa-agent/modules/${moduleId}/tasks/${taskId}` : undefined;
  const taskDirectoryAbsolute = taskReady ? taskDirectory(root, moduleId, taskId) : undefined;
  const mustStop = !uiExecutionAllowed;
  const nextAllowedAction = !promptBundle.current
    ? 'Run qa-agent prompts sync. Do not execute UI tools or write a QA report.'
    : !moduleReady || !taskReady
      ? 'Create the missing Module and Task through workflow bootstrap before any UI execution.'
      : !approved
        ? 'Present the returned plan and wait for explicit human approval. Do not execute UI tools or write a QA report.'
        : !capabilityReady
          ? `Attest and verify the required host capabilities: ${capabilityStatus?.missing.join(', ') || 'unknown'}, then retry task explore. Do not bypass the Runtime.`
          : !run || run.completedAt
          ? 'Start the first approved execution with qa-agent task explore.'
          : run.status === 'running'
            ? 'Use approved UI tools and persist every step and screenshot under this runId.'
            : 'Resolve the blocked Run before UI execution. Do not create a manual PASS report.';
  const allowedActions = uiExecutionAllowed
    ? ['ui.execute', 'run.step', 'run.observe', 'run.cleanup', 'run.complete']
    : workflowStatus === 'completed'
      ? ['run.show', 'run.report', 'operation.review', 'regression.run']
      : ['workflow.status', 'prompts.sync', 'task.review', 'host.attest', 'host.doctor', 'task.explore'];
  const forbiddenActions = uiExecutionAllowed
    ? ['manual-report.write', 'pass.claim-before-run-complete']
    : ['ui.execute', 'manual-report.write', 'pass.claim', 'operation-candidate.fabricate'];
  return {
    apiVersion: 'qa-agent/v2', kind: 'WorkflowState', request, moduleId, taskId,
    taskDirectory: taskDirectoryRef,
    taskDirectoryAbsolute,
    taskAssetsReady: taskReady,
    workflowStatus, uiExecutionAllowed, mustStop, manualReportAllowed: false,
    runId: uiExecutionAllowed ? run?.id : undefined,
    plan: task ? taskPlan(task) : undefined,
    promptBundle: { bundleHash: promptBundle.bundleHash, current: promptBundle.current, missing: promptBundle.missing, stale: promptBundle.stale },
    todoList: todos(moduleReady, taskReady, approved, capabilityReady, run),
    allowedActions,
    forbiddenActions,
    nextAllowedAction,
  };
}

export function bootstrapWorkflow(root: string, input: WorkflowBootstrapInput): QaWorkflowState {
  if (!input.request.trim()) throw new Error('--request is required.');
  const moduleCreated = !existsSync(join(modulePath(root, input.moduleId), 'module.json'));
  if (moduleCreated) {
    createModule(root, {
      id: input.moduleId,
      name: input.moduleName ?? input.moduleId,
      description: input.request,
      platforms: input.platforms?.length ? input.platforms : undefined,
      riskLevel: input.riskLevel,
      businessGoals: [input.request],
    });
  }
  const taskCreated = !existsSync(join(taskDirectory(root, input.moduleId, input.taskId), 'task.json'));
  if (taskCreated) {
    const task = createTaskSkeleton(readModule(root, input.moduleId), input.taskId, input.taskName ?? input.request.slice(0, 80));
    task.description = input.request;
    task.objectives = [input.request];
    task.scenarios[0]!.title = input.taskName ?? input.request.slice(0, 80);
    task.scenarios[0]!.intent = input.request;
    task.scenarios[0]!.expected = { outcome: `The requested business outcome is verified: ${input.request}` };
    task.scenarios[0]!.visualAssertions = [{ id: 'business-outcome', expected: `The visible result matches the approved request: ${input.request}`, importance: task.importance }];
    saveTask(root, task);
  }
  rebuildIndexes(root);
  const state = workflowStatus(root, input.moduleId, input.taskId, input.request);
  const directory = `.qa-agent/modules/${input.moduleId}/tasks/${input.taskId}`;
  return {
    ...state,
    bootstrap: {
      moduleCreated,
      taskCreated,
      taskDirectory: directory,
      taskAssets: [
        `${directory}/task.json`,
        `${directory}/module-snapshot.json`,
        `${directory}/requirements.json`,
        `${directory}/test-plan.json`,
        `${directory}/scenarios/happy-path.json`,
        `${directory}/runs/`,
        `${directory}/operation-plans/`,
      ],
    },
  };
}
