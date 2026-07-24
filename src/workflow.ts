import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { approvalIsCurrent, PLAN_REQUIREMENTS_CONFIRMATION_ZH, planReviewIsCurrent, requiresTestPlanApproval, START_TEST_CONFIRMATION_ZH, testPlanHash } from './approval.ts';
import { checkCapabilities, platformCapabilities } from './capabilities.ts';
import { appendTaskEvent, readTaskEvents, resumeToken, workflowContextHash } from './events.ts';
import { rebuildIndexes } from './indexer.ts';
import { listPythonRegressions } from './python-regression.ts';
import { createTaskSkeleton, taskPlan } from './planning.ts';
import { createModule, modulePath, readModule, readTask, saveTask, taskDirectory, taskPrdPath, taskSourceRunPath } from './project.ts';
import { readJson } from './store.ts';
import type { NextAction, QaWorkflowState, RiskLevel, TestRun, WorkflowGate, WorkflowPhase, WorkflowTodo } from './types.ts';
import { taskState as resolveTaskState } from './workflow-model.ts';
import { taskFinalizationIsCurrent } from './task-finalizer.ts';
import { planningPrdIsCurrent } from './task-prd.ts';

export interface WorkflowBootstrapInput { request: string; moduleId: string; taskId: string; moduleName?: string; taskName?: string; platforms?: string[]; riskLevel?: RiskLevel; }

function runMatchesCurrentPlan(task: NonNullable<ReturnType<typeof readTask>>, run: TestRun): boolean {
  return Boolean(run.planHash ? run.planHash === testPlanHash(task) : task.metadata.approval?.confirmedAt && run.startedAt >= task.metadata.approval.confirmedAt);
}

function latestRun(root: string, task: NonNullable<ReturnType<typeof readTask>>): TestRun | undefined {
  const path = taskSourceRunPath(root, task.metadata.moduleId, task.metadata.id);
  if (!existsSync(path)) return undefined;
  const run = readJson<TestRun>(path);
  return runMatchesCurrentPlan(task, run) ? run : undefined;
}

function todos(moduleReady: boolean, taskReady: boolean, planReady: boolean, questionsResolved: boolean, requirementsConfirmed: boolean, approvalRequired: boolean, executionAuthorized: boolean, capabilityReady: boolean, run?: TestRun, finalizationRequired = false, finalizationCurrent = false): WorkflowTodo[] {
  const running = run?.status === 'running'; const completed = Boolean(run?.completedAt);
  return [
    { id: 'project', title: 'Load the active QA project and Runtime state', status: 'completed' },
    { id: 'module', title: 'Resolve or create the business Module', status: moduleReady ? 'completed' : 'in_progress' },
    { id: 'task', title: 'Create the Task directory and planning assets', status: taskReady ? 'completed' : moduleReady ? 'in_progress' : 'pending' },
    { id: 'plan', title: 'Generate detailed Scenario steps and the reviewable Task PRD', status: planReady ? 'completed' : taskReady ? 'in_progress' : 'pending', blocking: true },
    { id: 'questions', title: 'Resolve every requirement question with the QA', status: questionsResolved ? 'completed' : planReady ? 'blocked' : 'pending', blocking: true },
    { id: 'requirements-review', title: `Wait for the QA to reply “${PLAN_REQUIREMENTS_CONFIRMATION_ZH}”`, status: requirementsConfirmed ? 'completed' : questionsResolved ? 'blocked' : 'pending', blocking: true },
    { id: 'approval', title: `Wait for the QA to reply “${START_TEST_CONFIRMATION_ZH}”`, status: executionAuthorized ? 'completed' : requirementsConfirmed ? 'blocked' : 'pending', blocking: approvalRequired },
    { id: 'capabilities', title: 'Verify host tools, environment, test data, and permissions', status: capabilityReady ? 'completed' : executionAuthorized ? 'blocked' : 'pending', blocking: true },
    { id: 'run', title: 'Start or resume the Task Run', status: running || completed ? 'completed' : executionAuthorized && capabilityReady ? 'in_progress' : 'pending' },
    { id: 'execute', title: 'Execute UI steps, assertions, evidence, recovery, and cleanup', status: running ? 'in_progress' : completed ? 'completed' : 'pending' },
    { id: 'finish', title: 'Generate the Runtime report and update the Task PRD', status: !completed ? 'pending' : !finalizationRequired || finalizationCurrent ? 'completed' : 'in_progress' },
  ];
}

function gate(id: string, satisfied: boolean, reasonCode: string, requiredActor: WorkflowGate['requiredActor'], artifactHash?: string, required = true): WorkflowGate { return { id, status: required ? satisfied ? 'satisfied' : 'blocking' : 'not_required', reasonCode, requiredActor, artifactHash }; }
function runProgressKey(run?: TestRun): string | undefined { return run ? [run.steps.length, run.visualFindings.length, run.cleanupFindings?.length ?? 0, run.evidence.length, run.recoveryAttempts?.length ?? 0, run.screenshots?.length ?? 0].join('-') : undefined; }

function runningNextActions(task: NonNullable<ReturnType<typeof readTask>>, run: TestRun): NextAction[] {
  const active = task.scenarios.filter(s => !run.scenarioId || s.id === run.scenarioId);
  if (task.metadata.mode === 'guided') {
    if (run.guidedPending?.type === 'execute_action') return [{ id: 'execute_guided_action', command: 'qa-agent run step', description: `Execute the single QA-approved action: ${run.guidedPending.action}`, requiresHuman: false, requiredActor: 'agent' }];
    if (run.guidedPending?.type === 'result_verdict') return [{ id: 'request_guided_verdict', command: 'qa-agent run guide-verdict', description: `Present step ${run.guidedPending.stepId} to the QA and ask whether the observed result matches expectations.`, requiresHuman: true, requiredActor: 'human', blockingGate: 'guided_result_verdict' }];
    const completedPlannedSteps = new Set(run.steps.filter(step => step.source === 'ui' && step.humanApproval && step.humanVerdict && step.plannedStepId).map(step => `${step.scenarioId}:${step.plannedStepId}`));
    const nextPlanned = active.flatMap(scenario => scenario.plannedSteps.map(step => ({ scenario, step }))).find(item => !completedPlannedSteps.has(`${item.scenario.id}:${item.step.id}`));
    if (nextPlanned) return [{ id: 'request_guided_action_approval', command: 'qa-agent run guide-approve', description: `Ask the QA whether to execute the next PRD step: ${nextPlanned.step.action} Expected: ${nextPlanned.step.expected}`, requiresHuman: true, requiredActor: 'human', blockingGate: 'guided_action_approval' }];
  }
  const missingAssertion = active.flatMap(s => (s.visualAssertions ?? []).map(a => ({ s, a }))).find(({ s, a }) => !run.visualFindings.some(f => f.scenarioId === s.id && f.assertionId === a.id));
  if (missingAssertion) {
    const hasUi = run.steps.some(step => step.source === 'ui');
    return hasUi
      ? [{ id: 'record_business_assertion', command: 'qa-agent run observe', description: `Record assertion ${missingAssertion.a.id} for Scenario ${missingAssertion.s.id}.`, requiresHuman: false, requiredActor: 'agent' }]
      : task.metadata.mode === 'guided'
        ? [{ id: 'request_guided_action_approval', command: 'qa-agent run guide-approve', description: `Ask the QA to approve the first UI action for Scenario ${missingAssertion.s.id}.`, requiresHuman: true, requiredActor: 'human', blockingGate: 'guided_action_approval' }]
        : [{ id: 'execute_scenario', command: 'qa-agent run step', description: 'Execute the next approved UI action and persist its screenshot and observed state.', requiresHuman: false, requiredActor: 'agent' }];
  }
  const missingCleanup = active.flatMap(s => s.cleanup.map(cleanup => ({ s, cleanup }))).find(({ s, cleanup }) => !run.cleanupFindings.some(f => f.scenarioId === s.id && f.cleanup === cleanup));
  if (missingCleanup) return [{ id: 'record_cleanup', command: 'qa-agent run cleanup', description: `Execute and record cleanup for Scenario ${missingCleanup.s.id}: ${missingCleanup.cleanup}.`, requiresHuman: false, requiredActor: 'agent' }];
  return [{ id: 'complete_run', command: 'qa-agent run complete', description: task.metadata.mode === 'guided' ? 'Complete the user-led Run, generate the authoritative report, and create one regression draft per Scenario.' : 'Complete the AI-led Run and let Runtime generate the authoritative report and Python-regression eligibility result.', requiresHuman: false, requiredActor: 'agent' }];
}

function breadcrumb(input: { moduleId: string; taskId: string; taskState: string; phase: WorkflowPhase; runId?: string; blockingGates: string[]; allowedActions: string[]; forbiddenActions: string[]; nextAction?: NextAction }): string {
  return ['<qa-workflow-state>', `Task: ${input.moduleId}/${input.taskId}`, `TaskState: ${input.taskState}`, `Phase: ${input.phase}`, `Run: ${input.runId ?? 'none'}`, `BlockingGates: ${input.blockingGates.join(', ') || 'none'}`, `AllowedActions: ${input.allowedActions.join(', ') || 'none'}`, `ForbiddenActions: ${input.forbiddenActions.join(', ') || 'none'}`, `NextAction: ${input.nextAction?.id ?? 'none'}`, '</qa-workflow-state>'].join('\n');
}

export function workflowStatus(root: string, moduleId: string, taskId: string, request?: string): QaWorkflowState {
  const moduleReady = existsSync(join(modulePath(root, moduleId), 'module.json'));
  const taskReady = moduleReady && existsSync(join(taskDirectory(root, moduleId, taskId), 'task.json'));
  const task = taskReady ? readTask(root, moduleId, taskId) : undefined;
  const planReady = Boolean(task && task.scenarios.length && task.scenarios.every(scenario => scenario.planningStatus === 'applicable' && scenario.plannedSteps?.length && scenario.plannedSteps.every(step => step.action.trim() && step.expected.trim())) && planningPrdIsCurrent(taskPrdPath(root, moduleId, taskId), task));
  const questionsResolved = Boolean(task && !(task.requirements?.userQuestions?.length));
  const requirementsConfirmed = Boolean(task && planReady && questionsResolved && planReviewIsCurrent(task));
  const approvalRequired = Boolean(task && requiresTestPlanApproval(task));
  const executionAuthorized = Boolean(task && requirementsConfirmed && approvalIsCurrent(task));
  const run = task ? latestRun(root, task) : undefined;
  const scripts = task ? listPythonRegressions(root, moduleId, taskId) : [];
  const validatedScripts = scripts.filter(script => script.status === 'validated' && task && script.sourcePlanHash === testPlanHash(task));
  const unverifiedScripts = scripts.filter(script => script.status === 'approved_unverified' && task && script.sourcePlanHash === testPlanHash(task));
  const capabilityStatus = task ? checkCapabilities(root, [...new Set([...task.capabilities.required, ...platformCapabilities(task.scope.platforms[0] ?? 'web')])], task.capabilities.optional) : undefined;
  const capabilityReady = Boolean(capabilityStatus && !capabilityStatus.missing.length);
  const taskState = resolveTaskState(task?.metadata.status);
  const quickFinalizationRequired = Boolean(task?.metadata.mode === 'quick' && run?.completedAt && !['blocked', 'paused', 'inconclusive'].includes(run.status));
  const quickFinalizationCurrent = Boolean(task && run && quickFinalizationRequired && taskFinalizationIsCurrent(root, task, run));
  let status: QaWorkflowState['workflowStatus']; let phase: WorkflowPhase; let reasonCode: string; let nextActions: NextAction[];

  if (!moduleReady || !taskReady) { status = 'setup_required'; phase = 'intake'; reasonCode = 'task_assets_missing'; nextActions = [{ id: 'start_task', command: 'qa-agent start', description: 'Create or resume the Module and Task directory before planning.', requiresHuman: false, requiredActor: 'agent', blockingGate: 'task_assets_ready' }]; }
  else if (taskState === 'archived') { status = 'completed'; phase = 'archive'; reasonCode = 'task_archived'; nextActions = []; }
  else if (!planReady) { status = 'setup_required'; phase = 'planning'; reasonCode = 'task_prd_or_detailed_steps_missing'; nextActions = [{ id: 'generate_detailed_plan', command: 'qa-agent plan apply', description: 'Inspect the project, generate detailed Scenario steps, and write the current plan into the Task PRD.', requiresHuman: false, requiredActor: 'agent', blockingGate: 'task_plan_ready' }]; }
  else if (!questionsResolved) { status = 'approval_required'; phase = 'planning'; reasonCode = 'qa_requirement_questions_unresolved'; nextActions = [{ id: 'resolve_requirement_question', description: `Ask the QA one unresolved question from the Task PRD: ${task?.requirements?.userQuestions?.[0]}`, requiresHuman: true, requiredActor: 'human', blockingGate: 'requirement_questions_resolved' }]; }
  else if (!requirementsConfirmed) { status = 'approval_required'; phase = 'approval'; reasonCode = 'test_plan_requirements_confirmation_required'; nextActions = [{ id: 'request_test_plan_requirements_confirmation', command: 'qa-agent plan review', description: `Present the complete Task PRD and ask whether it matches the QA requirement. Wait for the exact reply “${PLAN_REQUIREMENTS_CONFIRMATION_ZH}”.`, requiresHuman: true, requiredActor: 'human', blockingGate: 'test_plan_requirements_confirmed' }]; }
  else if (!executionAuthorized) { status = 'approval_required'; phase = 'approval'; reasonCode = 'explicit_start_confirmation_required'; nextActions = [{ id: 'request_test_plan_approval', command: 'qa-agent review', description: `The PRD is confirmed. Wait for the separate exact QA reply “${START_TEST_CONFIRMATION_ZH}” before execution.`, requiresHuman: true, requiredActor: 'human', blockingGate: 'test_plan_approved' }]; }
  else if (quickFinalizationRequired && !quickFinalizationCurrent) { status = 'result_ready'; phase = 'result_review'; reasonCode = task?.finalization?.status === 'failed' ? 'task_finalization_retry_required' : 'runtime_result_ready_for_finalization'; nextActions = [{ id: 'finalize_task', command: `qa-agent task finalize ${taskId} --module ${moduleId}`, description: 'Update the Quick Task PRD and completed state from the authoritative Runtime Run.', requiresHuman: false, requiredActor: 'runtime' }]; }
  else if (!capabilityReady) { status = 'blocked'; phase = 'preflight'; reasonCode = 'host_capability_missing'; nextActions = [{ id: 'verify_host_capabilities', command: 'qa-agent host doctor', description: `Verify or restore required capabilities: ${capabilityStatus?.missing.join(', ') || 'unknown'}.`, requiresHuman: false, requiredActor: 'host', blockingGate: 'host_capabilities_ready' }]; }
  else if (run?.status === 'running') { status = 'running'; phase = 'execution'; reasonCode = 'test_run_active'; nextActions = runningNextActions(task!, run); }
  else if (unverifiedScripts.length) { status = 'ready_to_run'; phase = 'regression'; reasonCode = 'python_regression_requires_validation'; nextActions = [{ id: 'run_python_regression', command: `qa-agent regression run ${unverifiedScripts[0]!.id} --module ${moduleId} --task ${taskId}`, description: 'Run the approved Python script once and validate its execution contract.', requiresHuman: false, requiredActor: 'host' }]; }
  else if (run?.completedAt) {
    status = ['blocked', 'paused'].includes(run.status) ? 'blocked' : 'completed'; phase = status === 'blocked' ? 'recovery' : 'result_review'; reasonCode = status === 'blocked' ? 'latest_run_blocked' : 'runtime_result_ready';
    if (status === 'blocked') nextActions = [{ id: 'resolve_run_blocker', description: 'Resolve the Runtime blocker and retry through qa-agent test; do not bypass the gate.', requiresHuman: run.blockActor === 'human', requiredActor: run.blockActor === 'human' ? 'human' : 'agent' }];
    else if (task?.metadata.mode === 'guided' && run.scenarioRegressionDrafts?.length) {
      status = 'result_ready'; phase = 'regression'; reasonCode = 'scenario_regression_drafts_ready';
      nextActions = [{ id: 'review_scenario_regressions', description: `Present the Runtime report and ${run.scenarioRegressionDrafts.length} Scenario regression draft(s). Each Scenario has one independent script and publication still requires review.`, requiresHuman: true, requiredActor: 'human' }];
    }
    else if (run.pythonRegressionEligibility?.eligible && !scripts.length) nextActions = [{ id: 'offer_python_regression', description: '测试已完成，并且本次流程符合生成回归脚本的条件。是否基于本次已验证流程生成 Python 回归脚本草稿？同意后只生成草稿，正式发布仍需单独审核和批准。', requiresHuman: true, requiredActor: 'human' }];
    else if (validatedScripts.length) nextActions = [{ id: 'archive_or_continue', command: 'qa-agent archive', description: 'Archive when the approved Python regressions, evidence, cleanup, and memory gates are satisfied.', requiresHuman: false, requiredActor: 'agent' }];
    else nextActions = [{ id: 'review_runtime_result', description: 'Present the Runtime report, screenshots, evidence, and Python-regression eligibility.', requiresHuman: false, requiredActor: 'agent' }];
  } else { status = 'ready_to_run'; phase = 'preflight'; reasonCode = 'approved_task_ready'; nextActions = [{ id: 'start_test', command: 'qa-agent test', description: 'Start the approved execution through the semantic test command.', requiresHuman: false, requiredActor: 'agent' }]; }

  const guidedUiReady = task?.metadata.mode !== 'guided' || run?.guidedPending?.type === 'execute_action';
  const uiExecutionAllowed = status === 'running' && Boolean(run?.id) && guidedUiReady; const mustStop = !uiExecutionAllowed;
  const gates: WorkflowGate[] = [gate('task_assets_ready', taskReady, taskReady ? 'task_assets_ready' : 'task_assets_missing', 'runtime'), gate('task_plan_ready', planReady, planReady ? 'task_prd_and_detailed_steps_ready' : 'task_prd_or_detailed_steps_missing', 'agent', task ? testPlanHash(task) : undefined, taskReady), gate('requirement_questions_resolved', questionsResolved, questionsResolved ? 'no_unresolved_qa_questions' : 'qa_questions_unresolved', 'human', task ? testPlanHash(task) : undefined, planReady), gate('test_plan_requirements_confirmed', requirementsConfirmed, requirementsConfirmed ? 'qa_confirmed_prd_matches_requirements' : 'qa_prd_confirmation_required', 'human', task ? testPlanHash(task) : undefined, planReady && questionsResolved), gate('test_plan_approved', executionAuthorized, executionAuthorized ? 'explicit_start_confirmation_recorded' : 'explicit_start_confirmation_required', 'human', task ? testPlanHash(task) : undefined, approvalRequired && requirementsConfirmed), gate('host_capabilities_ready', capabilityReady, capabilityReady ? 'host_capabilities_ready' : 'host_capability_missing', 'host', undefined, executionAuthorized), gate('task_assets_finalized', quickFinalizationCurrent, quickFinalizationCurrent ? 'task_assets_finalized' : 'task_finalization_pending', 'runtime', task?.finalization?.artifactHash, quickFinalizationRequired)];
  const allowedActions = uiExecutionAllowed ? ['ui.execute', 'run.step', 'run.evidence', 'run.observe', 'run.cleanup', 'run.recover', 'run.complete'] : [...new Set(nextActions.map(action => action.command).filter((v): v is string => Boolean(v)).concat(['workflow.status']))];
  const forbiddenActions = uiExecutionAllowed ? ['manual-report.write', 'pass.claim-before-run-complete'] : ['ui.execute', 'manual-report.write', 'pass.claim'];
  const events = taskReady ? readTaskEvents(root, moduleId, taskId) : []; const lastEvent = events.at(-1); const progress = runProgressKey(run);
  const scriptStates = scripts.map(script => [script.id, script.status, script.scriptHash]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const contextHash = workflowContextHash({ planHash: task ? testPlanHash(task) : undefined, taskState, workflowPhase: phase, runId: run?.id, runStatus: run?.status, runProgress: progress, pythonRegressionStates: scriptStates });
  const stateBreadcrumb = breadcrumb({ moduleId, taskId, taskState, phase, runId: run?.status === 'running' ? run.id : undefined, blockingGates: gates.filter(item => item.status === 'blocking').map(item => item.id), allowedActions, forbiddenActions, nextAction: nextActions[0] });
  return { apiVersion: 'qa-agent/v3', kind: 'WorkflowState', request, moduleId, taskId, taskDirectory: taskReady ? `.qa-agent/modules/${moduleId}/tasks/${taskId}` : undefined, taskDirectoryAbsolute: taskReady ? taskDirectory(root, moduleId, taskId) : undefined, taskAssetsReady: taskReady, workflowStatus: status, taskState, workflowPhase: phase, reasonCode, gates, uiExecutionAllowed, mustStop, manualReportAllowed: false, runId: run?.status === 'running' ? run.id : undefined, plan: task ? taskPlan(task) : undefined, todoList: todos(moduleReady, taskReady, planReady, questionsResolved, requirementsConfirmed, approvalRequired, executionAuthorized, capabilityReady, run, quickFinalizationRequired, quickFinalizationCurrent), allowedActions, forbiddenActions, nextAllowedAction: nextActions[0]?.description ?? 'No action is currently allowed.', nextActions, breadcrumb: stateBreadcrumb, resumeToken: taskReady ? resumeToken(moduleId, taskId, run?.status === 'running' ? run.id : undefined, lastEvent?.seq, run?.status === 'running' ? progress : undefined) : undefined, contextHash };
}

export function bootstrapWorkflow(root: string, input: WorkflowBootstrapInput): QaWorkflowState {
  if (!input.request.trim()) throw new Error('--request is required.');
  const moduleCreated = !existsSync(join(modulePath(root, input.moduleId), 'module.json'));
  if (moduleCreated) createModule(root, { id: input.moduleId, name: input.moduleName ?? input.moduleId, description: input.request, platforms: input.platforms?.length ? input.platforms : undefined, riskLevel: input.riskLevel, businessGoals: [input.request] });
  const taskCreated = !existsSync(join(taskDirectory(root, input.moduleId, input.taskId), 'task.json'));
  if (taskCreated) {
    const task = createTaskSkeleton(readModule(root, input.moduleId), input.taskId, input.taskName ?? input.request.slice(0, 80));
    task.description = input.request; task.objectives = [input.request]; task.metadata.status = 'planning'; task.scenarios[0]!.title = input.taskName ?? input.request.slice(0, 80); task.scenarios[0]!.intent = input.request; task.scenarios[0]!.planningStatus = 'needs_user_decision'; task.scenarios[0]!.priority = task.metadata.priority; task.scenarios[0]!.requirementRefs = ['requirement-1']; task.scenarios[0]!.expected = { outcome: `The requested business outcome is verified: ${input.request}` }; task.scenarios[0]!.visualAssertions = [{ id: 'business-outcome', expected: `The visible result matches the approved request: ${input.request}`, importance: task.scenarios[0]!.risk }];
    if (task.requirements) { task.requirements.businessGoals = [input.request]; task.requirements.scope.included = [input.request]; task.requirements.requirementTrace = [{ requirementId: 'requirement-1', scenarioIds: ['happy-path'], assertionIds: ['business-outcome'], sourceRefs: task.requirements.sourceRefs, status: 'covered' }]; }
    saveTask(root, task); appendTaskEvent(root, { type: 'task_created', actor: { type: 'agent', id: 'qa-agent' }, moduleId: input.moduleId, taskId: input.taskId, fromState: 'draft', toState: 'planning', reasonCode: 'qa_request_materialized_for_detailed_planning', artifactHash: testPlanHash(task), idempotencyKey: `task-created:${input.moduleId}:${input.taskId}:v1`, metadata: { requestSummary: input.request.slice(0, 160) } });
  }
  rebuildIndexes(root); const state = workflowStatus(root, input.moduleId, input.taskId, input.request); const directory = `.qa-agent/modules/${input.moduleId}/tasks/${input.taskId}`;
  return { ...state, bootstrap: { moduleCreated, taskCreated, taskDirectory: directory, taskAssets: [`${directory}/task.json`, `${directory}/module-snapshot.json`, `${directory}/requirements.json`, `${directory}/test-plan.json`, `${directory}/prd.md`, `${directory}/scenarios/happy-path.json`, `${directory}/events.jsonl`, `${directory}/source-run/`, `${directory}/regression/`, `${directory}/regression-runs/`] } };
}
