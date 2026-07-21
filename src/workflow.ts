import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { approvalIsCurrent, testPlanHash } from './approval.ts';
import { checkCapabilities, platformCapabilities } from './capabilities.ts';
import { appendTaskEvent, readTaskEvents, resumeToken, workflowContextHash } from './events.ts';
import { rebuildIndexes } from './indexer.ts';
import { listOperations, readOperation } from './operations.ts';
import { createTaskSkeleton, taskPlan } from './planning.ts';
import { createModule, modulePath, readModule, readProjectPromptBundle, readTask, saveTask, taskDirectory } from './project.ts';
import { listFiles, readJson } from './store.ts';
import type { NextAction, QaWorkflowState, RiskLevel, TestRun, WorkflowGate, WorkflowPhase, WorkflowTodo } from './types.ts';
import { normalizeTaskState } from './workflow-model.ts';

export interface WorkflowBootstrapInput {
  request: string;
  moduleId: string;
  taskId: string;
  moduleName?: string;
  taskName?: string;
  platforms?: string[];
  riskLevel?: RiskLevel;
}

function runMatchesCurrentPlan(root: string, task: NonNullable<ReturnType<typeof readTask>>, run: TestRun): boolean {
  const currentPlanHash = testPlanHash(task);
  if (run.planHash) return run.planHash === currentPlanHash;
  if (run.operationPlanId) {
    try { return readOperation(root, task, run.operationPlanId).planHash === currentPlanHash; }
    catch { return false; }
  }
  return Boolean(task.metadata.approval?.confirmedAt && run.startedAt >= task.metadata.approval.confirmedAt);
}

function latestRun(root: string, task: NonNullable<ReturnType<typeof readTask>>): TestRun | undefined {
  const directory = join(taskDirectory(root, task.metadata.moduleId, task.metadata.id), 'runs');
  if (!existsSync(directory)) return undefined;
  return listFiles(directory, path => path.endsWith('/run.json'))
    .map(path => readJson<TestRun>(path))
    .filter(run => runMatchesCurrentPlan(root, task, run))
    .sort((left, right) => Number(right.status === 'running') - Number(left.status === 'running') || right.startedAt.localeCompare(left.startedAt))[0];
}

function todos(moduleReady: boolean, taskReady: boolean, approved: boolean, capabilityReady: boolean, run?: TestRun): WorkflowTodo[] {
  const running = run?.status === 'running';
  const completed = Boolean(run?.completedAt);
  return [
    { id: 'project', title: 'Load the active QA project and canonical Prompt Bundle', status: 'completed' },
    { id: 'module', title: 'Resolve or create the business Module', status: moduleReady ? 'completed' : 'in_progress' },
    { id: 'task', title: 'Create the Task directory and planning assets', status: taskReady ? 'completed' : moduleReady ? 'in_progress' : 'pending' },
    { id: 'plan', title: 'Review scope, Scenario matrix, assertions, evidence, safety, and cleanup', status: taskReady ? 'completed' : 'pending' },
    { id: 'approval', title: 'Wait for explicit human TestPlan approval', status: approved ? 'completed' : taskReady ? 'blocked' : 'pending', blocking: true },
    { id: 'capabilities', title: 'Verify host tools, environment, test data, and permissions', status: capabilityReady ? 'completed' : approved ? 'blocked' : 'pending', blocking: true },
    { id: 'run', title: 'Start or resume the approved Task Run', status: running || completed ? 'completed' : approved && capabilityReady ? 'in_progress' : 'pending' },
    { id: 'execute', title: 'Execute UI steps, assertions, evidence, recovery, and cleanup', status: running ? 'in_progress' : completed ? 'completed' : 'pending' },
    { id: 'finish', title: 'Review the Runtime report and OperationPlan lifecycle', status: completed ? 'completed' : 'pending' },
  ];
}

function gate(id: string, satisfied: boolean, reasonCode: string, requiredActor: WorkflowGate['requiredActor'], artifactHash?: string, required = true): WorkflowGate {
  return { id, status: required ? (satisfied ? 'satisfied' : 'blocking') : 'not_required', reasonCode, requiredActor, artifactHash };
}

function runProgressKey(run: TestRun | undefined): string | undefined {
  if (!run) return undefined;
  return [run.steps.length, run.replayCursor ?? 0, run.visualFindings.length, run.cleanupFindings?.length ?? 0, run.evidence.length, run.recoveryAttempts?.length ?? 0, run.screenshots?.length ?? 0, run.replayStage].join('-');
}

function runningNextActions(root: string, task: NonNullable<ReturnType<typeof readTask>>, run: TestRun): NextAction[] {
  if (run.replayStatus !== 'not_replay' && run.operationPlanId) {
    const operation = readOperation(root, task, run.operationPlanId);
    const nextStep = operation.steps[run.replayCursor ?? 0];
    if (nextStep) return [{ id: 'execute_operation_step', command: 'qa-agent run step', description: `Execute OperationPlan step ${nextStep.id} and persist its screenshot and observed state.`, requiresHuman: false, requiredActor: 'agent' }];
  }
  const activeScenarios = task.scenarios.filter(scenario => !run.scenarioId || scenario.id === run.scenarioId);
  const missingAssertion = activeScenarios.flatMap(scenario => (scenario.visualAssertions ?? []).map(assertion => ({ scenario, assertion })))
    .find(({ scenario, assertion }) => !run.visualFindings.some(finding => finding.scenarioId === scenario.id && finding.assertionId === assertion.id));
  if (missingAssertion) {
    const hasUiProgress = run.steps.some(step => step.source === 'ui' || step.source === 'operation-replay');
    if (run.replayStatus === 'not_replay' && !hasUiProgress) return [{ id: 'execute_scenario', command: 'qa-agent run step', description: 'Execute the next approved exploratory UI action and persist its screenshot and observed state.', requiresHuman: false, requiredActor: 'agent' }];
    return [{ id: 'record_business_assertion', command: 'qa-agent run observe', description: `Record assertion ${missingAssertion.assertion.id} for Scenario ${missingAssertion.scenario.id}.`, requiresHuman: false, requiredActor: 'agent' }];
  }
  const missingCleanup = activeScenarios.flatMap(scenario => scenario.cleanup.map(cleanup => ({ scenario, cleanup })))
    .find(({ scenario, cleanup }) => !run.cleanupFindings.some(finding => finding.scenarioId === scenario.id && finding.cleanup === cleanup));
  if (missingCleanup) return [{ id: 'record_cleanup', command: 'qa-agent run cleanup', description: `Execute and record cleanup for Scenario ${missingCleanup.scenario.id}: ${missingCleanup.cleanup}.`, requiresHuman: false, requiredActor: 'agent' }];
  return [{ id: 'complete_run', command: 'qa-agent run complete', description: 'Complete the Run and let Runtime generate the authoritative report and OperationPlan result.', requiresHuman: false, requiredActor: 'agent' }];
}

function breadcrumb(input: {
  moduleId: string;
  taskId: string;
  taskState: string;
  phase: WorkflowPhase;
  runId?: string;
  blockingGates: string[];
  allowedActions: string[];
  forbiddenActions: string[];
  nextAction?: NextAction;
}): string {
  const lines = [
    '<qa-workflow-state>',
    `Task: ${input.moduleId}/${input.taskId}`,
    `TaskState: ${input.taskState}`,
    `Phase: ${input.phase}`,
    `Run: ${input.runId ?? 'none'}`,
    `BlockingGates: ${input.blockingGates.length ? input.blockingGates.join(', ') : 'none'}`,
    `AllowedActions: ${input.allowedActions.length ? input.allowedActions.join(', ') : 'none'}`,
    `ForbiddenActions: ${input.forbiddenActions.length ? input.forbiddenActions.join(', ') : 'none'}`,
    `NextAction: ${input.nextAction?.id ?? 'none'}`,
    '</qa-workflow-state>',
  ];
  return lines.join('\n');
}

export function workflowStatus(root: string, moduleId: string, taskId: string, request?: string): QaWorkflowState {
  const moduleReady = existsSync(join(modulePath(root, moduleId), 'module.json'));
  const taskReady = moduleReady && existsSync(join(taskDirectory(root, moduleId, taskId), 'task.json'));
  const task = taskReady ? readTask(root, moduleId, taskId) : undefined;
  const approved = Boolean(task && approvalIsCurrent(task));
  const run = task ? latestRun(root, task) : undefined;
  const operations = task ? listOperations(root, task) : [];
  const approvedUnverified = operations.filter(plan => plan.status === 'approved_unverified' && plan.planHash === testPlanHash(task!));
  const validated = operations.filter(plan => plan.status === 'validated' && plan.planHash === testPlanHash(task!));
  const candidate = operations.filter(plan => plan.status === 'candidate' && plan.planHash === testPlanHash(task!));
  const validatedScenarioIds = new Set(validated.map(plan => plan.scenarioId));
  const allScenariosValidated = Boolean(task && task.scenarios.length > 0 && task.scenarios.every(scenario => validatedScenarioIds.has(scenario.id)));
  const capabilityStatus = task ? checkCapabilities(root, [...new Set([...task.capabilities.required, ...platformCapabilities(task.scope.platforms[0] ?? 'web')])], task.capabilities.optional) : undefined;
  const capabilityReady = Boolean(capabilityStatus && !capabilityStatus.missing.length);
  const promptBundle = readProjectPromptBundle(root);
  const taskState = normalizeTaskState(task?.metadata.status);

  let workflowStatus: QaWorkflowState['workflowStatus'];
  let workflowPhase: WorkflowPhase;
  let reasonCode: string;
  let nextActions: NextAction[];

  if (!promptBundle.current) {
    workflowStatus = 'blocked'; workflowPhase = 'recovery'; reasonCode = 'prompt_bundle_stale';
    nextActions = [{ id: 'sync_prompts', command: 'qa-agent prompts sync', description: 'Synchronize the canonical Prompt Bundle before any execution.', requiresHuman: false, requiredActor: 'agent', blockingGate: 'prompt_bundle_current' }];
  } else if (!moduleReady || !taskReady) {
    workflowStatus = 'setup_required'; workflowPhase = 'intake'; reasonCode = 'task_assets_missing';
    nextActions = [{ id: 'start_task', command: 'qa-agent start', description: 'Create or resume the Module, Task, TestPlan, Scenario, and Todo assets.', requiresHuman: false, requiredActor: 'agent', blockingGate: 'task_assets_ready' }];
  } else if (taskState === 'archived') {
    workflowStatus = 'completed'; workflowPhase = 'archive'; reasonCode = 'task_archived';
    nextActions = [];
  } else if (!approved) {
    workflowStatus = 'approval_required'; workflowPhase = 'approval'; reasonCode = 'test_plan_approval_required';
    nextActions = [{ id: 'request_test_plan_approval', description: 'Present the current plan diff and request explicit human approval.', requiresHuman: true, requiredActor: 'human', blockingGate: 'test_plan_approved' }];
  } else if (!capabilityReady) {
    workflowStatus = 'blocked'; workflowPhase = 'preflight'; reasonCode = 'host_capability_missing';
    nextActions = [{ id: 'verify_host_capabilities', command: 'qa-agent host doctor', description: `Verify or restore required capabilities: ${capabilityStatus?.missing.join(', ') || 'unknown'}.`, requiresHuman: false, requiredActor: 'host', blockingGate: 'host_capabilities_ready' }];
  } else if (run?.status === 'running') {
    workflowStatus = 'running'; workflowPhase = run.replayStatus === 'not_replay' ? 'execution' : 'regression'; reasonCode = run.replayStatus === 'not_replay' ? 'explore_run_active' : 'replay_run_active';
    nextActions = runningNextActions(root, task!, run);
  } else if (approvedUnverified.length) {
    workflowStatus = 'ready_to_run'; workflowPhase = 'regression'; reasonCode = 'operation_plan_requires_validation';
    nextActions = [{ id: 'validate_operation_plan', command: 'qa-agent test', description: 'Replay the approved but unverified OperationPlan through a real Runtime Run.', requiresHuman: false, requiredActor: 'agent' }];
  } else if (candidate.length) {
    workflowStatus = 'completed'; workflowPhase = 'operation_promotion'; reasonCode = 'operation_candidate_approval_required';
    nextActions = [{ id: 'request_operation_plan_approval', description: 'Present Runtime-generated OperationPlan candidates and request explicit promotion approval.', requiresHuman: true, requiredActor: 'human', blockingGate: 'operation_plan_approved' }];
  } else if (run?.completedAt) {
    workflowStatus = ['blocked', 'paused', 'needs_confirmation'].includes(run.status) ? 'blocked' : 'completed';
    workflowPhase = workflowStatus === 'blocked' ? 'recovery' : validated.length ? 'result_review' : 'result_review';
    reasonCode = workflowStatus === 'blocked' ? 'latest_run_blocked' : validated.length ? 'validated_regression_available' : 'runtime_result_ready';
    nextActions = workflowStatus === 'blocked'
      ? [{ id: 'resolve_run_blocker', description: 'Resolve the Runtime blocker and retry through qa-agent test; do not bypass the gate.', requiresHuman: run.status === 'needs_confirmation', requiredActor: run.status === 'needs_confirmation' ? 'human' : 'agent' }]
      : allScenariosValidated && ['passed', 'adapted'].includes(run.status)
        ? [{ id: 'archive_or_continue', command: 'qa-agent archive', description: 'Archive when all Scenario, regression, evidence, and memory gates are satisfied.', requiresHuman: false, requiredActor: 'agent' }]
        : run.status === 'failed'
          ? [{ id: 'review_failed_result', description: 'Review the failed business assertions, preserve the validated replay contract, address the defect, then rerun qa-agent test.', requiresHuman: false, requiredActor: 'agent' }]
          : [{ id: 'review_runtime_result', description: 'Review the Runtime report and address any missing replay contract fields.', requiresHuman: false, requiredActor: 'agent' }];
  } else {
    workflowStatus = 'ready_to_run'; workflowPhase = 'preflight'; reasonCode = 'approved_task_ready';
    nextActions = [{ id: 'start_test', command: 'qa-agent test', description: 'Start the approved execution through the semantic test command.', requiresHuman: false, requiredActor: 'agent' }];
  }

  const uiExecutionAllowed = workflowStatus === 'running' && Boolean(run?.id);
  const taskDirectoryRef = taskReady ? `.qa-agent/modules/${moduleId}/tasks/${taskId}` : undefined;
  const taskDirectoryAbsolute = taskReady ? taskDirectory(root, moduleId, taskId) : undefined;
  const mustStop = !uiExecutionAllowed;
  const gates: WorkflowGate[] = [
    gate('prompt_bundle_current', promptBundle.current, promptBundle.current ? 'prompt_bundle_current' : 'prompt_bundle_stale', 'runtime', promptBundle.bundleHash),
    gate('task_assets_ready', taskReady, taskReady ? 'task_assets_ready' : 'task_assets_missing', 'runtime'),
    gate('test_plan_approved', approved, approved ? 'test_plan_approved' : 'test_plan_approval_required', 'human', task ? testPlanHash(task) : undefined, taskReady),
    gate('host_capabilities_ready', capabilityReady, capabilityReady ? 'host_capabilities_ready' : 'host_capability_missing', 'host', undefined, approved),
    gate('operation_plan_approved', approvedUnverified.length > 0 || validated.length > 0, candidate.length ? 'operation_candidate_approval_required' : 'operation_plan_not_required', 'human', undefined, candidate.length > 0),
    gate('operation_plan_validated', allScenariosValidated, allScenariosValidated ? 'all_scenarios_have_validated_operation_plans' : 'operation_plan_validation_pending', 'runtime', undefined, approvedUnverified.length > 0 || validated.length > 0),
  ];
  const allowedActions = uiExecutionAllowed
    ? ['ui.execute', 'run.step', 'run.evidence', 'run.observe', 'run.cleanup', 'run.recover', 'run.complete']
    : [...new Set(nextActions.map(action => action.command).filter((value): value is string => Boolean(value)).concat(['workflow.status']))];
  const forbiddenActions = uiExecutionAllowed
    ? ['manual-report.write', 'pass.claim-before-run-complete', 'operation-candidate.fabricate']
    : ['ui.execute', 'manual-report.write', 'pass.claim', 'operation-candidate.fabricate'];
  const events = taskReady ? readTaskEvents(root, moduleId, taskId) : [];
  const lastEvent = events.at(-1);
  const progress = runProgressKey(run);
  const operationStates = operations.map(plan => [plan.id, plan.status, plan.planHash]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const contextHash = workflowContextHash({ promptBundleHash: promptBundle.bundleHash, planHash: task ? testPlanHash(task) : undefined, taskState, workflowPhase, runId: run?.id, runStatus: run?.status, runProgress: progress, operationStates });
  const nextAllowedAction = nextActions[0]?.description ?? 'No action is currently allowed.';
  const stateBreadcrumb = breadcrumb({ moduleId, taskId, taskState, phase: workflowPhase, runId: run?.status === 'running' ? run.id : undefined, blockingGates: gates.filter(item => item.status === 'blocking').map(item => item.id), allowedActions, forbiddenActions, nextAction: nextActions[0] });

  return {
    apiVersion: 'qa-agent/v3', kind: 'WorkflowState', request, moduleId, taskId,
    taskDirectory: taskDirectoryRef,
    taskDirectoryAbsolute,
    taskAssetsReady: taskReady,
    workflowStatus,
    taskState,
    workflowPhase,
    reasonCode,
    gates,
    uiExecutionAllowed,
    mustStop,
    manualReportAllowed: false,
    runId: uiExecutionAllowed ? run?.id : undefined,
    plan: task ? taskPlan(task) : undefined,
    promptBundle: { bundleHash: promptBundle.bundleHash, current: promptBundle.current, missing: promptBundle.missing, stale: promptBundle.stale },
    todoList: todos(moduleReady, taskReady, approved, capabilityReady, run),
    allowedActions,
    forbiddenActions,
    nextAllowedAction,
    nextActions,
    breadcrumb: stateBreadcrumb,
    resumeToken: taskReady ? resumeToken(moduleId, taskId, run?.status === 'running' ? run.id : undefined, lastEvent?.seq, run?.status === 'running' ? progress : undefined) : undefined,
    contextHash,
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
    task.metadata.status = 'awaiting_approval';
    task.scenarios[0]!.title = input.taskName ?? input.request.slice(0, 80);
    task.scenarios[0]!.intent = input.request;
    task.scenarios[0]!.planningStatus = 'applicable';
    task.scenarios[0]!.priority = task.metadata.priority;
    task.scenarios[0]!.requirementRefs = ['requirement-1'];
    task.scenarios[0]!.expected = { outcome: `The requested business outcome is verified: ${input.request}` };
    task.scenarios[0]!.visualAssertions = [{ id: 'business-outcome', expected: `The visible result matches the approved request: ${input.request}`, importance: task.scenarios[0]!.risk }];
    if (task.requirements) {
      task.requirements.businessGoals = [input.request];
      task.requirements.scope.included = [input.request];
      task.requirements.requirementTrace = [{ requirementId: 'requirement-1', scenarioIds: ['happy-path'], assertionIds: ['business-outcome'], sourceRefs: task.requirements.sourceRefs, status: 'covered' }];
    }
    saveTask(root, task);
    appendTaskEvent(root, {
      type: 'task_created',
      actor: { type: 'agent', id: 'qa-agent' },
      moduleId: input.moduleId,
      taskId: input.taskId,
      fromState: 'draft',
      toState: 'awaiting_approval',
      reasonCode: 'qa_request_materialized',
      artifactHash: testPlanHash(task),
      idempotencyKey: `task-created:${input.moduleId}:${input.taskId}:v1`,
      metadata: { requestSummary: input.request.slice(0, 160) },
    });
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
        `${directory}/events.jsonl`,
        `${directory}/runs/`,
        `${directory}/operation-plans/`,
      ],
    },
  };
}
